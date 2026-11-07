do {
    $env:NATIVE_SSH_ASKPASS_FILE = Join-Path $env:TEMP ("native-ssh-askpass-{0}.tmp" -f (Get-Random))
} while (Test-Path -LiteralPath $env:NATIVE_SSH_ASKPASS_FILE)

$p = Start-Process -FilePath $env:NATIVE_SSH_NODE_BIN -ArgumentList (@($env:NATIVE_SSH_ASKPASS_NODE_SCRIPT) + $args) -NoNewWindow -PassThru -Wait
$AskpassStatus = $p.ExitCode

if (Test-Path -LiteralPath $env:NATIVE_SSH_ASKPASS_FILE) {
    if ($AskpassStatus -eq 0) {
        Get-Content -LiteralPath $env:NATIVE_SSH_ASKPASS_FILE -Raw
    }
    Remove-Item -LiteralPath $env:NATIVE_SSH_ASKPASS_FILE -Force -ErrorAction SilentlyContinue
}

exit $AskpassStatus
