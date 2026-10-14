# escape=`

FROM mcr.microsoft.com/windows/servercore:ltsc2022

ARG CULTURE=fr-FR

SHELL ["powershell", "-NoProfile", "-Command", "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';"]

RUN `
    # Set culture
    $languageList = New-WinUserLanguageList -Language $env:CULTURE; `
    Set-WinSystemLocale -SystemLocale $env:CULTURE; `
    Set-WinUserLanguageList -LanguageList $languageList -Force; `
    Set-Culture -CultureInfo $env:CULTURE; `
    `
    # Install
    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0

COPY start-sshd.ps1 C:/start-sshd.ps1

EXPOSE 2222

ENTRYPOINT ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:/start-sshd.ps1"]
