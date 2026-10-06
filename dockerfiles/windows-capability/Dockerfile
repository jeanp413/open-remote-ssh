FROM mcr.microsoft.com/windows/servercore:ltsc2022

SHELL ["powershell", "-NoProfile", "-Command"]

RUN Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0

COPY start-sshd.ps1 C:/start-sshd.ps1

EXPOSE 2222

ENTRYPOINT ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:/start-sshd.ps1"]
