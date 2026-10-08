# escape=`

FROM mcr.microsoft.com/windows/servercore:ltsc2022

SHELL ["powershell", "-NoProfile", "-Command", "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';"]

RUN `
    # Force TLS 1.2 for the connection
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; `
    `
    $url = ('https://github.com/msys2/msys2-installer/releases/latest/download/msys2-x86_64-latest.exe'); `
    $dest = ('C:\msys2-installer.exe'); `
    `
    # Download the file
    Write-Host "Downloading from $url"; `
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing; `
    `
    # Extract and cleanup
    $process = Start-Process -FilePath $dest -ArgumentList @('in', '--confirm-command', '--accept-messages', '--root', 'C:\msys64') -Wait -PassThru; `
    if ($process.ExitCode -ne 0) { throw "MSYS2 installer failed with exit code $($process.ExitCode)" }; `
    Remove-Item $dest; `
    `
    # Update
    & 'C:\msys64\usr\bin\bash.exe' -lc 'pacman -Syu --noconfirm'; `
    if ($LASTEXITCODE -ne 0) { throw "MSYS2 package update failed with exit code $LASTEXITCODE" }; `
    `
    # Install
    & 'C:\msys64\usr\bin\bash.exe' -lc 'pacman -S --noconfirm openssh'; `
    if ($LASTEXITCODE -ne 0) { throw "MSYS2 OpenSSH installation failed with exit code $LASTEXITCODE" }

COPY start-sshd.ps1 C:/start-sshd.ps1

EXPOSE 2222

ENTRYPOINT ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:/start-sshd.ps1"]
