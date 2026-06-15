# Start TriliumNext if it isn't already running.
# Safe to call repeatedly — exits 0 whether it starts or was already up.

$triliumExe = "C:\Users\miiso\AppData\Local\trilium\trilium.exe"

if (-not (Test-Path $triliumExe)) {
    Write-Error "Trilium not found at $triliumExe"
    exit 1
}

$running = Get-Process -Name "trilium" -ErrorAction SilentlyContinue
if ($running) {
    Write-Output "Trilium is already running."
    exit 0
}

Write-Output "Starting Trilium..."
Start-Process -FilePath $triliumExe
Write-Output "Trilium launched. Allow a few seconds for the server to become ready on port 37840."
exit 0
