param([string]$OutputDirectory = '')
$ErrorActionPreference = 'Stop'
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $PSScriptRoot '..\Build\Tests' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$testExe = Join-Path $OutputDirectory 'PerfectIndexTests.exe'
& $compiler /nologo /target:exe /optimize+ /reference:System.dll /reference:System.Core.dll /reference:System.Security.dll /reference:System.Web.Extensions.dll "/out:$testExe" (Join-Path $PSScriptRoot 'PerfectNodeIndex.cs') (Join-Path $PSScriptRoot 'Tests\PerfectIndexTests.cs')
if ($LASTEXITCODE -ne 0) { throw 'Perfect-index test compilation failed.' }
& $testExe
if ($LASTEXITCODE -ne 0) { throw 'Perfect-index tests failed.' }
