FROM mcr.microsoft.com/windows/servercore:ltsc2022

SHELL ["powershell", "-NoProfile", "-Command"]

ARG OPENSSH_VERSION=10.0.0.0p2-Preview

RUN Invoke-WebRequest -Uri "https://github.com/PowerShell/Win32-OpenSSH/releases/download/${OPENSSH_VERSION}/OpenSSH-Win64.zip" -OutFile C:/OpenSSH-Win64.zip; \
    Expand-Archive -Path C:/OpenSSH-Win64.zip -DestinationPath C:/; \
    Rename-Item C:/OpenSSH-Win64 C:/OpenSSH; \
    Remove-Item C:/OpenSSH-Win64.zip; \
    & C:/OpenSSH/install-sshd.ps1

COPY start-sshd.ps1 C:/start-sshd.ps1

EXPOSE 2222

ENTRYPOINT ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:/start-sshd.ps1"]
