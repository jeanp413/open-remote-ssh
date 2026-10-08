# escape=`

FROM mcr.microsoft.com/windows/servercore:ltsc2022

ARG GIT_VERSION=2.56.0

SHELL ["powershell", "-NoProfile", "-Command", "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';"]

RUN `
    Write-Host "Downloading Git version ${env:GIT_VERSION}..." ; `
    # Force TLS 1.2 for the connection
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; `
    `
    $url = ('https://github.com/git-for-windows/git/releases/download/v${0}.windows.1/Git-${0}-64-bit.exe' -f $env:GIT_VERSION); `
    $dest = ('C:\Git-Installer.exe'); `
    `
    # Download the file
    Write-Host "Downloading from $url"; `
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing; `
    `
    # Extract and cleanup
    $process = Start-Process -FilePath $dest -ArgumentList '/VERYSILENT /NORESTART /SP- /SUPPRESSMSGBOXES /DIR="C:\Program Files\Git"' -Wait -PassThru; `
    if ($process.ExitCode -ne 0) { throw "Git for Windows installer failed with exit code $($process.ExitCode)" }; `
    Remove-Item $dest; `
    `
    # Install
    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0; `
    `
    # Set default shell
    New-ItemProperty -Path HKLM:\SOFTWARE\OpenSSH -Name DefaultShell -Value 'C:\Program Files\Git\bin\bash.exe' -PropertyType String -Force; `
    New-ItemProperty -Path HKLM:\SOFTWARE\OpenSSH -Name DefaultShellCommandOption -Value '-c' -PropertyType String -Force

COPY start-sshd.ps1 C:/start-sshd.ps1

EXPOSE 2222

ENTRYPOINT ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:/start-sshd.ps1"]
