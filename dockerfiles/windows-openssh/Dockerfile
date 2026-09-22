FROM mcr.microsoft.com/windows/servercore:ltsc2022

ARG OPENSSH_VERSION=10.0.0.0p2-Preview

SHELL ["powershell", "-NoProfile", "-Command", "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';"]

RUN Write-Host "Downloading OpenSSH version ${env:OPENSSH_VERSION}..." ; \
    # Force TLS 1.2 for the connection
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; \
    \
    $url = ('https://github.com/PowerShell/Win32-OpenSSH/releases/download/{0}/OpenSSH-Win64.zip' -f $env:OPENSSH_VERSION); \
    $dest = "C:/OpenSSH-Win64.zip"; \
    Write-Host "Downloading from: $url"; \
    \
    # Download the file
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing; \
    \
    # Extract and cleanup
    Expand-Archive -Path $dest -DestinationPath C:/OpenSSH-Temp; \
    Move-Item -Path C:/OpenSSH-Temp/OpenSSH-Win64 -Destination C:/OpenSSH; \
    Remove-Item -Path $dest; \
    Remove-Item -Path C:/OpenSSH-Temp -Recurse; \
    \
    # Install
    C:/OpenSSH/install-sshd.ps1

COPY start-sshd.ps1 C:/start-sshd.ps1

EXPOSE 2222

ENTRYPOINT ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:/start-sshd.ps1"]
