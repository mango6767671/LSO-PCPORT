param(
    [string]$BaseUrl = "http://localhost"
)

$ErrorActionPreference = "Stop"
$BaseUrl = $BaseUrl.TrimEnd("/")
$hostAccount = $null
$guestAccount = $null
$sessionId = $null

function New-SmokeTestAccount([string]$Prefix) {
    $id = [Guid]::NewGuid().ToString("N").ToLower()
    $body = @{
        email = "$Prefix-$id@example.test"
        displayName = $Prefix + $id.Substring(0, 8)
        password = "PcPort!" + $id + "Aa1"
    }
    return Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/pc/v1/auth/register" -ContentType "application/json" -Body ($body | ConvertTo-Json)
}

function Invoke-AuthenticatedJson(
    [string]$Method,
    [string]$Path,
    [string]$Token,
    $Body = $null
) {
    $parameters = @{
        Method = $Method
        Uri = "$BaseUrl$Path"
        Headers = @{ Authorization = "Bearer $Token" }
        ErrorAction = "Stop"
    }
    if ($null -ne $Body) {
        $parameters.ContentType = "application/json"
        $parameters.Body = $Body | ConvertTo-Json -Depth 5
    }
    return Invoke-RestMethod @parameters
}

try {
    Write-Host "[1/7] Checking PC-port capability endpoint..."
    $status = Invoke-RestMethod -Uri "$BaseUrl/api/pc/v1/status"
    if ($status.service -ne "lso-pcport" -or $status.accountApi -ne "enabled") {
        throw "Unexpected PC-port status response."
    }
    if ($status.gameTransport -ne "not-implemented" -or $status.gtaVPC161Compatibility -ne "not-verified") {
        throw "Status response did not accurately describe the current port limits."
    }

    Write-Host "[2/7] Registering temporary host account..."
    $hostAccount = New-SmokeTestAccount "Host"

    Write-Host "[3/7] Registering temporary guest account..."
    $guestAccount = New-SmokeTestAccount "Guest"

    Write-Host "[4/7] Creating a temporary session listing..."
    $created = Invoke-AuthenticatedJson "POST" "/api/pc/v1/sessions" $hostAccount.token @{
        label = "PC port smoke test"
        gameVersion = "smoke-test"
        region = "us-east"
        maxPlayers = 4
        private = $false
    }
    $sessionId = $created.session.id

    Write-Host "[5/7] Finding the listing with the guest account..."
    $listing = Invoke-AuthenticatedJson "GET" "/api/pc/v1/sessions?gameVersion=smoke-test&region=us-east" $guestAccount.token
    if (-not ($listing.sessions | Where-Object { $_.id -eq $sessionId })) {
        throw "The guest account could not find the newly created public listing."
    }

    Write-Host "[6/7] Joining and leaving the listing..."
    $joined = Invoke-AuthenticatedJson "POST" "/api/pc/v1/sessions/$sessionId/join" $guestAccount.token @{}
    if (-not $joined.ok -or $joined.currentPlayers -ne 2) {
        throw "Join did not produce the expected two-player directory count."
    }
    $left = Invoke-AuthenticatedJson "POST" "/api/pc/v1/sessions/$sessionId/leave" $guestAccount.token @{}
    if (-not $left.left -or $left.currentPlayers -ne 1) {
        throw "Leave did not restore the host-only directory count."
    }

    Write-Host "[7/7] Verifying host heartbeat and logging out..."
    $heartbeat = Invoke-AuthenticatedJson "POST" "/api/pc/v1/sessions/$sessionId/heartbeat" $hostAccount.token @{}
    if (-not $heartbeat.ok) { throw "Host heartbeat failed." }

    Write-Host ""
    Write-Host "PASS: independent account auth, session discovery, join/leave, and heartbeat work."
    Write-Host "This checks only the PC-port backend API; it does not test GTA V 1.61 or in-game networking."
}
finally {
    if ($hostAccount -and $hostAccount.token -and $sessionId) {
        try { $null = Invoke-AuthenticatedJson "POST" "/api/pc/v1/sessions/$sessionId/leave" $hostAccount.token @{} } catch {}
    }
    if ($guestAccount -and $guestAccount.token) {
        try { $null = Invoke-AuthenticatedJson "POST" "/api/pc/v1/auth/logout" $guestAccount.token @{} } catch {}
    }
    if ($hostAccount -and $hostAccount.token) {
        try { $null = Invoke-AuthenticatedJson "POST" "/api/pc/v1/auth/logout" $hostAccount.token @{} } catch {}
    }
}
