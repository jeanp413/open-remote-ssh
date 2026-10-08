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
Subsystem sftp C:/OpenSSH/sftp-server.exe
"@

Set-Content -Path C:/ProgramData/ssh/sshd_config -Value $sshdConfig
Set-Service -Name sshd -StartupType Automatic
New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 2222 -ErrorAction SilentlyContinue
Start-Service sshd

while ($true) {
    Start-Sleep -Seconds 30
}
