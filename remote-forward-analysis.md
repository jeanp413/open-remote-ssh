# Анализ поддержки `RemoteForward`

## Резюме

Open Remote SSH разбирает и сохраняет директивы `RemoteForward`, включая несколько директив для одного хоста, но основной SSH-бэкенд на базе `ssh2` их не применяет. В нём реализован только прямой локальный форвардинг через `forwardOut`; обратный форвардинг требует `forwardIn`, обработки входящих каналов `tcp connection` и последующего `unforwardIn`, которых в текущей абстракции и реализации нет.

Исключение — native-бэкенд, используемый для GSSAPI. Он запускает системный OpenSSH с исходным конфигурационным файлом, поэтому OpenSSH может применить `RemoteForward` самостоятельно. При добавлении общей поддержки нельзя повторно регистрировать те же remote listeners в native-пути.

Ссылки на строки ниже соответствуют исследованному snapshot репозитория. Если исходники изменятся, номера строк могут сместиться.

## 1. Корневая причина

Цепочка обработки обрывается между вычислением SSH-конфигурации и транспортным слоем:

1. Пакет `ssh-config` распознаёт `RemoteForward` как повторяемую директиву.
2. `SSHConfiguration.getHostConfiguration()` возвращает все совпавшие значения в `RemoteForward[]`.
3. `RemoteSSHResolver.connect()` не читает `sshHostConfig['RemoteForward']`.
4. Интерфейс `SSHClient` не предоставляет API обратного форвардинга.
5. `SSHConnection` использует `ssh2.Client.forwardOut()`, но нигде не вызывает `forwardIn()` или `unforwardIn()` и не обрабатывает событие `tcp connection`.

Таким образом, `RemoteForward` не отбрасывается парсером. Для канонического написания он сохраняется, но затем игнорируется основным `ssh2`-бэкендом.

Дополнительная проблема: таблица нормализации не содержит `remoteforward`. Каноническое `RemoteForward` работает на уровне хранения, но `remoteforward` или смешанный регистр останется под исходным ключом. Будущий код, читающий только `sshHostConfig['RemoteForward']`, пропустит такие варианты.

## 2. Релевантные файлы и функции

| Файл | Строки | Назначение |
| --- | ---: | --- |
| [`src/ssh/sshConfig.ts`](src/ssh/sshConfig.ts#L8) | 8–25 | `HostConfiguration`; `RemoteForward`, `LocalForward` и `DynamicForward` типизированы как массивы. |
| [`src/ssh/sshConfig.ts`](src/ssh/sshConfig.ts#L53) | 53–76 | `SSH_CONFIG_PROPERTIES` и `normalizeProp()`; отсутствует нормализация `remoteforward`. |
| [`src/ssh/sshConfig.ts`](src/ssh/sshConfig.ts#L78) | 78–88 | `normalizeSSHConfig()` рекурсивно нормализует директивы. |
| [`src/ssh/sshConfig.ts`](src/ssh/sshConfig.ts#L103) | 103–139 | `parseSSHConfigFromFile()` читает конфигурацию и раскрывает `Include`. |
| [`src/ssh/sshConfig.ts`](src/ssh/sshConfig.ts#L157) | 157–162 | `SSHConfiguration.loadFromFS()` объединяет пользовательскую и системную конфигурации. |
| [`src/ssh/sshConfig.ts`](src/ssh/sshConfig.ts#L184) | 184–186 | `getHostConfiguration()` вызывает `sshConfig.compute(host)`. |
| [`package.json`](package.json#L50) | 50–57 | Зависимости `ssh-config@5.3.0` и fork `ssh2`. |
| [`src/authResolver.ts`](src/authResolver.ts#L193) | 193–203 | Состояние resolver-а: SSH-соединение, SOCKS-туннель и список локальных туннелей. |
| [`src/authResolver.ts`](src/authResolver.ts#L210) | 210–248 | `resolve()` загружает SSH config и выбирает обычный либо native-путь. |
| [`src/authResolver.ts`](src/authResolver.ts#L268) | 268–424 | `connect()` вычисляет host config, строит ProxyJump/ProxyCommand и создаёт SSH-клиент. |
| [`src/authResolver.ts`](src/authResolver.ts#L424) | 424 | `await this.sshConnection.connect()` — рекомендуемая точка применения `RemoteForward`. |
| [`src/authResolver.ts`](src/authResolver.ts#L465) | 465–475 | Создание SOCKS-туннеля и локального туннеля к remote extension host. |
| [`src/authResolver.ts`](src/authResolver.ts#L684) | 684–739 | `openTunnel()` реализует локальный TCP/Unix forwarding напрямую или через SOCKS. |
| [`src/authResolver.ts`](src/authResolver.ts#L860) | 860–871 | `dispose()` закрывает известные туннели и SSH-соединение. |
| [`src/ssh/sshClient.ts`](src/ssh/sshClient.ts#L19) | 19–33 | Общий интерфейс SSH-клиента; reverse-forwarding API отсутствует. |
| [`src/ssh/sshConnection.ts`](src/ssh/sshConnection.ts#L22) | 22–34 | `SSHTunnelConfig` описывает локальный listener и удалённую цель. |
| [`src/ssh/sshConnection.ts`](src/ssh/sshConnection.ts#L55) | 55–67 | `SSHConnection` и реестр `activeTunnels`. |
| [`src/ssh/sshConnection.ts`](src/ssh/sshConnection.ts#L162) | 162–173 | `forwardOut()` — обёртка над `ssh2.Client.forwardOut()`. |
| [`src/ssh/sshConnection.ts`](src/ssh/sshConnection.ts#L185) | 185–244 | `close()` и `connect()`, включая обработку `ready`, `error` и `close`. |
| [`src/ssh/sshConnection.ts`](src/ssh/sshConnection.ts#L255) | 255–320 | `addTunnel()` создаёт локальный TCP/SOCKS listener и открывает `forwardOut`. |
| [`src/ssh/sshConnection.ts`](src/ssh/sshConnection.ts#L325) | 325–348 | `closeTunnel()` закрывает локальные listeners. |
| [`src/ssh/nativeClient.ts`](src/ssh/nativeClient.ts#L71) | 71–113 | Аргументы системного OpenSSH для ControlMaster, exec и forwarding. |
| [`src/ssh/nativeClient.ts`](src/ssh/nativeClient.ts#L372) | 372–404 | Native `addTunnel()` создаёт процессы `ssh -L`/`ssh -D`. |
| [`src/ssh/nativeClient.ts`](src/ssh/nativeClient.ts#L445) | 445–478 | Закрытие native forwarding-процессов и ControlMaster. |
| [`src/extension.ts`](src/extension.ts#L6) | 6–12 | Регистрация resolver-а и его lifecycle через `context.subscriptions`. |

## 3. Существующая архитектура SSH-форвардинга

### 3.1 Локальный TCP forwarding

Текущий путь соответствует OpenSSH `LocalForward`/`-L` по направлению трафика, хотя сами директивы `LocalForward` также автоматически не применяются:

```text
локальный клиент
      │
      ▼
net.Server на 127.0.0.1
      │
      ▼
SSHConnection.addTunnel()
      │
      ▼
ssh2.Client.forwardOut()
      │
      ▼
удалённый host:port или Unix socket
```

`SSHConnection.addTunnel()` создаёт локальный `net.Server`. Для каждого входящего соединения вызывается `forwardOut()`, после чего локальный socket и SSH channel соединяются через `pipe()`.

### 3.2 Dynamic/SOCKS forwarding

При `remote.SSH.enableDynamicForwarding` resolver создаёт локальный SOCKS listener. SOCKS-запросы преобразуются в `ssh2.forwardOut()` к требуемой цели. Этот же путь может использоваться `openTunnel()` для подключения к порту remote extension host.

### 3.3 ProxyJump

Для каждого jump host создаётся отдельный `SSHConnection`. `forwardOut()` предыдущего соединения формирует stream, который передаётся следующему SSH-клиенту как `sock`. Это отдельное применение прямого SSH channel и не является `RemoteForward`.

### 3.4 Native OpenSSH

`NativeSSHConnection` создаёт ControlMaster и отдельные `ssh -L`/`ssh -D` процессы. Поскольку всем процессам передаётся исходный `-F <config>` и не устанавливается `ClearAllForwardings=yes`, системный OpenSSH самостоятельно видит `RemoteForward`.

Native-путь в текущей архитектуре выбирается для конфигураций, запрашивающих GSSAPI. Обычные подключения продолжают использовать `ssh2` и поэтому игнорируют `RemoteForward`.

### 3.5 Интерактивный Ports UI

`RemoteSSHResolver` не реализует `RemoteAuthorityResolver.tunnelFactory`. Команда `setContext('forwardedPortsViewEnabled', true)` только включает UI. При отсутствии custom factory VS Code использует стандартный механизм forwarding.

Поддержку SSH-config `RemoteForward` следует добавлять отдельным путём, не меняя `openTunnel()`, `addTunnel()` и поведение интерактивного Ports UI.

### 3.6 Отсутствующий reverse path

Для OpenSSH `RemoteForward` необходим следующий путь:

```text
listener на SSH-сервере
      │
      ▼
SSH tcpip-forward / forwarded-tcpip
      │
      ▼
ssh2: forwardIn() + событие tcp connection
      │
      ▼
net.connect() на локальной машине
      │
      ▼
локальный target host:port
```

Ни один из центральных элементов этого пути сейчас не реализован.

## 4. Предлагаемая минимальная реализация

### 4.1 Нормализация и разбор директив

Добавить в `SSH_CONFIG_PROPERTIES` как минимум:

```ts
remoteforward: 'RemoteForward',
exitonforwardfailure: 'ExitOnForwardFailure',
clearallforwardings: 'ClearAllForwardings',
```

Желательно одновременно канонизировать `localforward` и `dynamicforward`, чтобы forwarding-директивы обрабатывались единообразно.

Добавить отдельный parser значения `RemoteForward`. Нельзя использовать простой `split(':')` или `split(/\s+/)`: необходимо корректно обрабатывать IPv6, квадратные скобки, кавычки, Unix socket paths и альтернативный синтаксис с `/`.

### 4.2 Отдельная модель reverse tunnel

Не менять смысл существующего `SSHTunnelConfig`, который описывает локальный listener. Ввести отдельную структуру, например `SSHRemoteTunnelConfig`, содержащую:

- remote bind address и port либо remote socket path;
- local target host и port либо local socket path;
- фактически назначенный remote port для запроса с port `0`;
- стабильное имя/идентификатор для cleanup;
- исходную строку config для логов и диагностики.

### 4.3 Расширение `SSHClient`

Добавить отдельные методы, например:

```ts
addRemoteTunnel(config: SSHRemoteTunnelConfig): Promise<SSHRemoteTunnel>;
closeRemoteTunnel(name?: string): Promise<void>;
```

Существующие `addTunnel()` и `closeTunnel()` оставить без изменения. Это отделит reverse forwarding от интерактивного и служебного local forwarding.

### 4.4 Реализация в `SSHConnection`

Для TCP:

1. Убедиться, что SSH transport подключён.
2. Зарегистрировать маршрутизацию входящих каналов.
3. Вызвать `ssh2.Client.forwardIn(bindAddress, bindPort, callback)`.
4. Сохранить фактический port, возвращённый сервером, особенно при `bindPort === 0`.
5. На `tcp connection` выбрать соответствующую регистрацию.
6. Вызвать `accept()` и открыть `net.connect(localHost, localPort)`.
7. Соединить оба потока и симметрично обрабатывать `close`/`error`.
8. При cleanup вызвать `unforwardIn(bindAddress, actualPort)` и удалить обработчики/metadata.

Предпочтителен один общий обработчик `tcp connection` с внутренней таблицей маршрутов. Отдельный event listener на каждую директиву повышает риск двойного `accept()` и утечек обработчиков.

Для Unix sockets использовать `openssh_forwardInStreamLocal`, `unix connection` и соответствующий cancel API.

### 4.5 Точка интеграции

Применять вычисленные directives сразу после:

```ts
await this.sshConnection.connect();
```

в `RemoteSSHResolver.connect()`, до установки/запуска remote extension host.

На этой стадии SSH-аутентификация завершена, ProxyJump/ProxyCommand уже установлены, а ошибки bind можно обработать до успешного завершения resolver-а.

Директивы следует применять последовательно и в порядке, возвращённом `ssh-config`. Это упрощает `ExitOnForwardFailure`, откат частично созданных listeners и детерминированные логи.

### 4.6 Native-бэкенд

В native-пути не следует повторно вызывать новую reverse-forwarding реализацию: системный OpenSSH уже применяет исходный config. Минимальный вариант — пропустить явное применение по `useNativeClient` или реализовать документированный no-op в `NativeSSHConnection`.

Альтернатива — запускать native master с `ClearAllForwardings=yes` и применять все forwards через единый внутренний API. Это обеспечило бы единообразие, но является заметно более крупным изменением и не относится к минимальному patch.

## 5. Требования совместимости с OpenSSH

### Обязательные требования

- **Несколько директив.** Все `RemoteForward[]` должны применяться; нельзя брать только первое или последнее значение.
- **Регистронезависимые ключи.** `RemoteForward`, `remoteforward` и смешанный регистр должны давать одинаковый результат.
- **Сторона разрешения target.** `host:hostport` разрешяется и открывается на локальной стороне SSH-клиента. Нельзя принудительно заменять target host на `127.0.0.1`.
- **Bind по умолчанию.** Отсутствующий bind address должен сохранять loopback-семантику OpenSSH.
- **Wildcard bind.** Пустой bind address и `*` означают запрос listener-а на всех интерфейсах; успех зависит от серверного `GatewayPorts`.
- **IPv4 и IPv6.** Поддержать адреса в квадратных скобках и не разбирать IPv6 простым разделением по двоеточию.
- **Port `0`.** Сохранить и сообщить фактически назначенный сервером port.
- **`ExitOnForwardFailure`.** При `yes` ошибка любого listener-а должна прервать подключение и закрыть уже открытые listeners. При `no`/по умолчанию ошибка логируется, остальные forwards продолжают применяться.
- **`ClearAllForwardings`.** При `yes` config forwards не должны создаваться.
- **Серверные ограничения.** Ошибки `AllowTcpForwarding`, `PermitListen`, занятый port и отказ `GatewayPorts` должны корректно поступать из callback `forwardIn`.
- **Потоковая очистка.** Ошибка или закрытие SSH channel либо локального socket должны закрывать вторую сторону.

### Подстановки и пути

`RemoteForward` допускает `%`-подстановки. Текущий `valuesToInterpolate` не покрывает как минимум `%C` и `%j`. До применения директив следует определить полный набор поддерживаемых токенов и не использовать частичную подстановку, которая тихо меняет семантику.

Unix socket paths также требуют отдельной обработки `~`, переменных окружения и платформенных различий. Расширение допустимо только там, где его делает OpenSSH.

## 6. Ошибки, cleanup и reconnection

### 6.1 Ошибки создания listener-а

Каждая ошибка должна содержать исходную директиву, remote bind и local target. Нельзя логировать ошибку только как общий `forwardIn failed`, поскольку при нескольких директивах будет невозможно определить проблемную.

При `ExitOnForwardFailure yes` алгоритм должен:

1. остановить применение следующих directives;
2. отменить уже зарегистрированные remote listeners;
3. закрыть SSH-соединение;
4. вернуть ошибку из resolver-а.

При значении `no` ошибка должна быть видна в Remote SSH output, но не блокировать основное подключение.

### 6.2 Штатное закрытие

Reverse registrations должны принадлежать конкретному `SSHConnection`, а не общему массиву `RemoteSSHResolver.tunnels`. `SSHConnection.close()` должен сначала отменить remote listeners и удалить обработчики, затем закрыть обычные tunnels и вызвать `Client.end()`.

Если transport уже закрыт, `unforwardIn()` может бросить `Not connected`. Cleanup должен всё равно очистить локальное состояние и считать удалённый listener уже исчезнувшим вместе с SSH-сессией.

### 6.3 Неожиданный disconnect

Сейчас `SSHConnection` создаётся с `reconnect: false`; resolver полагается на повторный вызов `resolve()` со стороны VS Code. При неожиданном закрытии:

- remote listener исчезает вместе с SSH transport;
- активные forwarded channels должны закрыться;
- JS metadata и event handlers необходимо очистить;
- новый вызов `resolve()` должен заново прочитать config и повторно отправить все forwarding requests.

Если в будущем будет включён внутренний `SSHConnection.reconnect`, directives потребуется регистрировать после каждого нового события `ready`, а не только один раз в `RemoteSSHResolver.connect()`.

### 6.4 Существующие lifecycle-риски

Текущий unexpected-close path не закрывает `activeTunnels`, если внутренний reconnect отключён. Кроме того, disposable из `openTunnel()` обращается к текущему `this.sshConnection`, а не обязательно к соединению, создавшему tunnel. После повторного resolve старый listener потенциально может остаться без корректного владельца.

Новая reverse-forwarding реализация не должна повторять эту схему: cleanup callback должен захватывать конкретный объект соединения или полностью жить внутри него.

### 6.5 Native cleanup

В native-пути remote listeners принадлежат основному процессу OpenSSH/ControlMaster и исчезают при его завершении или `ssh -O exit`. На Windows без ControlMaster вспомогательные команды также читают исходный config и могут повторно пытаться создать `RemoteForward`. Для будущего hardening вспомогательные native-команды следует запускать с `ClearAllForwardings=yes`, оставляя forwards только у основного владельца соединения.

## 7. Рекомендуемые регрессионные тесты

### 7.1 Парсер и вычисление конфигурации

1. Одна директива:

   ```sshconfig
   RemoteForward 9000 127.0.0.1:3000
   ```

   Ожидание: `RemoteForward === ['9000 127.0.0.1:3000']`.

2. Несколько `RemoteForward` в одном `Host` — порядок и все элементы сохранены.
3. Директивы из `Host *` и конкретного `Host` накапливаются по правилам OpenSSH.
4. Директивы из `Include` сохраняются и применяются.
5. `RemoteForward`, `remoteforward` и смешанный регистр дают один канонический ключ.
6. `ClearAllForwardings yes` подавляет накопленные forwards.
7. Невалидная спецификация выдаёт диагностическую ошибку с исходным значением.

### 7.2 TCP reverse forwarding

1. Remote port принимает соединение и передаёт данные локальному TCP-сервису.
2. Несколько remote forwards работают одновременно и не смешивают каналы.
3. Local target — не loopback, а произвольное DNS-имя/IP, доступное с клиента.
4. IPv6 local target в квадратных скобках.
5. Явный remote bind address.
6. Port `0`: возвращённый сервером port сохраняется и используется при cleanup.
7. Несколько одновременных подключений через один listener.
8. Ошибка local `net.connect()` закрывает SSH channel без утечки.
9. Закрытие SSH channel закрывает local socket.

### 7.3 Ошибки и политика запуска

1. Занятый remote port с `ExitOnForwardFailure no`: основное SSH-подключение успешно, ошибка записана в лог.
2. Занятый remote port с `ExitOnForwardFailure yes`: resolver завершается ошибкой.
3. При ошибке второй из нескольких директив и `ExitOnForwardFailure yes` первый listener отменяется.
4. Отказ сервера из-за `AllowTcpForwarding` корректно диагностируется.
5. Запрос non-loopback bind при запрещённом `GatewayPorts` не маскируется как локальная ошибка.

### 7.4 Cleanup и reconnect

1. `closeRemoteTunnel()` вызывает `unforwardIn()` ровно один раз.
2. `SSHConnection.close()` отменяет все remote listeners и удаляет event handlers.
3. Unexpected disconnect очищает локальное состояние без попытки использовать закрытый transport.
4. Повторный `resolve()` создаёт listeners заново на новом соединении.
5. После нескольких reconnect нет дублирующихся обработчиков и нескольких listeners для одной директивы.
6. Старый cleanup callback не закрывает tunnel нового соединения с тем же именем.

### 7.5 Совместимость с существующим forwarding

1. Служебный tunnel к remote extension host продолжает работать.
2. Dynamic/SOCKS forwarding продолжает работать.
3. ProxyJump продолжает строить цепочку через `forwardOut()`.
4. Интерактивное добавление/удаление port forwarding в Ports UI не меняется.
5. Native GSSAPI-путь не пытается зарегистрировать `RemoteForward` второй раз.

### 7.6 Unix sockets — при включении в initial scope

1. Remote Unix socket → local TCP port.
2. Remote TCP port → local Unix socket.
3. Remote Unix socket → local Unix socket.
4. Cleanup удаляет регистрацию и корректно обрабатывает существующий socket path.

## 8. Известные ограничения и отложенные возможности

Следующие функции разумно не включать в минимальный TCP patch, но неподдерживаемые формы должны явно диагностироваться, а не игнорироваться:

- Remote dynamic SOCKS forwarding, когда у `RemoteForward` указан только remote listener без статического target.
- Все комбинации TCP и Unix domain sockets.
- Полная совместимость с `StreamLocalBindMask` и `StreamLocalBindUnlink`.
- Полный набор `%`-токенов, включая корректное вычисление `%C` и `%j`.
- Переменные окружения в Unix socket paths согласно правилам конкретной версии OpenSSH.
- Альтернативный forwarding-синтаксис с `/`, если initial parser поддерживает только стандартную форму с `:`.
- Публикация динамически назначенного remote port в UI.
- Единая реализация remote forwarding для `ssh2` и native-бэкендов через один transport-neutral API.
- Внутренний reconnect в `SSHConnection` с автоматическим повторным применением forwarding registrations.
- Общий рефакторинг lifecycle существующих local tunnels при повторном `resolve()`.
- Автоматическое применение `LocalForward` и `DynamicForward` из SSH config. Они также типизированы и вычисляются parser-ом, но не являются частью исправления `RemoteForward`.

## Рекомендация по объёму первого изменения

Минимальный безопасный patch должен включать:

1. регистронезависимую нормализацию нужных директив;
2. parser статического TCP `RemoteForward`;
3. отдельный reverse-forward API в `SSHClient`;
4. `forwardIn`/`tcp connection`/`unforwardIn` в `SSHConnection`;
5. применение всех directives сразу после успешного `connect()`;
6. `ExitOnForwardFailure`, cleanup и повторное создание после нового `resolve()`;
7. защиту от двойного применения в native-пути;
8. регрессионные тесты для parser-а, нескольких listeners, ошибок, cleanup, reconnect и неизменности существующего forwarding.

Существующие `openTunnel()`, SOCKS/local forwarding, ProxyJump и VS Code interactive forwarding для этого менять не требуется.
