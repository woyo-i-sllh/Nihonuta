[CmdletBinding()]
param(
    [string]$Source = 'F:\life\songs\日语歌',
    [switch]$Publish,
    [string]$Message = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$site = Join-Path $repo 'site'
$builder = Join-Path $PSScriptRoot 'build_site.py'

$python = Get-Command python -ErrorAction SilentlyContinue
$pythonArgs = @()
if (-not $python) {
    $python = Get-Command py -ErrorAction SilentlyContinue
    $pythonArgs += '-3'
}
if (-not $python) {
    throw 'Python 3 was not found in PATH.'
}

Write-Host "Source: $Source"
Write-Host "Site:   $site"
& $python.Source @pythonArgs $builder --source $Source --site $site
if ($LASTEXITCODE -ne 0) {
    throw "Site build failed with exit code $LASTEXITCODE."
}

Push-Location $repo
try {
    if (-not $Publish) {
        Write-Host ''
        Write-Host 'Build complete. Git status:'
        git status --short
        Write-Host ''
        Write-Host 'Run again with -Publish to commit and push the update.'
        return
    }

    git branch -M main
    git add --all
    git diff --cached --quiet
    if ($LASTEXITCODE -eq 0) {
        Write-Host 'No changes to publish.'
        return
    }
    if ($LASTEXITCODE -ne 1) {
        throw 'Unable to inspect staged changes.'
    }

    if (-not $Message) {
        $Message = "Update lyric archive $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
    }
    git commit -m $Message
    if ($LASTEXITCODE -ne 0) {
        throw 'git commit failed.'
    }
    git push -u origin main
    if ($LASTEXITCODE -ne 0) {
        throw 'git push failed. Check GitHub authentication and repository permissions.'
    }
    Write-Host 'Published. GitHub Pages will deploy automatically.'
}
finally {
    Pop-Location
}