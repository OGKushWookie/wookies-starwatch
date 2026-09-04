param(
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$sourceDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDirectory = Split-Path -Parent $sourceDirectory
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $projectDirectory 'Build'
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

$compilerCandidates = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $compiler) { throw '.NET Framework 4.x C# compiler was not found.' }

$outputPath = Join-Path $OutputDirectory 'WookiesStarwatch.exe'
$arguments = @(
    '/nologo',
    '/target:winexe',
    '/platform:anycpu',
    '/optimize+',
    '/debug-',
    '/main:PortableLauncher',
    "/out:$outputPath",
    "/resource:$projectDirectory\overlay.js,WookiesStarwatch.overlay.js",
    "/resource:$projectDirectory\LICENSE,WookiesStarwatch.LICENSE.txt",
    '/reference:System.dll',
    '/reference:System.Core.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Security.dll',
    '/reference:System.Web.Extensions.dll',
    '/reference:System.Windows.Forms.dll',
    (Join-Path $sourceDirectory 'PortableLauncher.cs'),
    (Join-Path $sourceDirectory 'Injector.cs')
)

& $compiler $arguments
if ($LASTEXITCODE -ne 0) { throw "C# compilation failed with exit code $LASTEXITCODE." }

$testStart = New-Object Diagnostics.ProcessStartInfo
$testStart.FileName = $outputPath
$testStart.Arguments = '--self-test'
$testStart.UseShellExecute = $false
$testStart.CreateNoWindow = $true
$testStart.RedirectStandardOutput = $true
$testStart.RedirectStandardError = $true
$testProcess = New-Object Diagnostics.Process
$testProcess.StartInfo = $testStart
if (-not $testProcess.Start()) { throw 'Embedded-overlay self-test process could not start.' }
$testOutput = $testProcess.StandardOutput.ReadToEnd()
$testError = $testProcess.StandardError.ReadToEnd()
$testProcess.WaitForExit()
if ($testOutput) { Write-Host $testOutput.TrimEnd() }
if ($testError) { Write-Error $testError.TrimEnd() }
if ($testProcess.ExitCode -ne 0) { throw "Embedded-overlay self-test failed with exit code $($testProcess.ExitCode)." }

$hash = (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash
[IO.File]::WriteAllText(
    (Join-Path $OutputDirectory 'SHA256SUMS.txt'),
    "$hash  WookiesStarwatch.exe`n",
    (New-Object Text.UTF8Encoding($false))
)

Write-Host "Built: $outputPath"
Write-Host "SHA-256: $hash"
