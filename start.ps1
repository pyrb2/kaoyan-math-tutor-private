$ErrorActionPreference = 'Stop'

$projectRoot = $PSScriptRoot
$bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue

if ($nodeCommand) {
    $node = $nodeCommand.Source
} elseif (Test-Path -LiteralPath $bundledNode -PathType Leaf) {
    $node = $bundledNode
} else {
    throw '需要 Node.js 24 或更高版本。未找到可用的 node.exe。'
}

$major = [int]((& $node -p "process.versions.node.split('.')[0]").Trim())
if ($major -lt 24 -and (Test-Path -LiteralPath $bundledNode -PathType Leaf)) {
    $node = $bundledNode
    $major = [int]((& $node -p "process.versions.node.split('.')[0]").Trim())
}
if ($major -lt 24) {
    throw "需要 Node.js 24 或更高版本，当前版本为 $major。"
}

Push-Location -LiteralPath $projectRoot
try {
    & $node 'src/server.mjs'
} finally {
    Pop-Location
}
