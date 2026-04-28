param(
  [int]$Port = 3200
)

$runtimeNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$nodeCommand = $null

if (Get-Command node -ErrorAction SilentlyContinue) {
  $nodeCommand = "node"
} elseif (Test-Path $runtimeNode) {
  $nodeCommand = $runtimeNode
} else {
  throw "Node.js nao encontrado. Instala Node ou usa este projeto dentro do Codex."
}

$env:PORT = $Port
& $nodeCommand "server.js"
