## Build Images

```bash
./dockerfiles/build.sh
```

### Debugging Image

### Run Image in Interactive Mode

```bash
docker run -it --name open-remote-ssh-test --publish 2222:2222 --env USER_NAME=openremotessh --env USER_PASSWORD=openremotessh --env PASSWORD_ACCESS=true --env SUDO_ACCESS=false --env LOG_STDOUT=true local-ubuntu-bash bash
```

### Test Setup Script

```
/usr/local/bin/start-sshd.sh
```

### Delete Container

```
docker rm -f open-remote-ssh-test
```
