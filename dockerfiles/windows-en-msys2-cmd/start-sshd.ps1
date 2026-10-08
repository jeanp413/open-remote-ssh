$ErrorActionPreference = 'Stop'

$username = $env:USER_NAME
$password = ConvertTo-SecureString $env:USER_PASSWORD -AsPlainText -Force

if (-not (Get-LocalUser -Name $username -ErrorAction SilentlyContinue)) {
    New-LocalUser -Name $username -Password $password -PasswordNeverExpires -UserMayNotChangePassword
    Add-LocalGroupMember -Group Administrators -Member $username
} else {
    Set-LocalUser -Name $username -Password $password
}

$sshdConfig = @"
Port 2222
PasswordAuthentication yes
PubkeyAuthentication yes
Subsystem sftp /usr/lib/ssh/sftp-server
"@

[System.IO.Directory]::CreateDirectory('C:/msys64/etc/ssh') | Out-Null
[System.IO.File]::WriteAllText('C:/msys64/etc/ssh/sshd_config', $sshdConfig, [System.Text.UTF8Encoding]::new($false))

New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 2222 -ErrorAction SilentlyContinue

& 'C:/msys64/usr/bin/bash.exe' -lc 'ssh-keygen -A && exec sshd -D -e'
if ($LASTEXITCODE -ne 0) {
    throw "MSYS2 sshd exited with code $LASTEXITCODE"
}
