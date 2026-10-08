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
Subsystem sftp sftp-server.exe
"@

Set-Content -Path C:/ProgramData/ssh/sshd_config -Value $sshdConfig
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd

while ($true) {
    Start-Sleep -Seconds 30
}
