# Myrient Download Manager - Script de Instalación Automática
# Este script descarga la aplicación desde Google Drive y la instala

param(
    [string]$InstallPath = "$env:LOCALAPPDATA\Myrient Download Manager",
    [switch]$SkipCleanup = $false
)

# Colores para output
function Write-Status {
    param([string]$Message, [string]$Type = "Info")
    $colors = @{
        "Success" = "Green"
        "Error"   = "Red"
        "Warning" = "Yellow"
        "Info"    = "Cyan"
    }
    Write-Host $Message -ForegroundColor $colors[$Type]
}

function Write-Header {
    param([string]$Message)
    Write-Host ""
    Write-Host "╔$('═' * ($Message.Length + 2))╗" -ForegroundColor Cyan
    Write-Host "║ $Message ║" -ForegroundColor Cyan
    Write-Host "╚$('═' * ($Message.Length + 2))╝" -ForegroundColor Cyan
    Write-Host ""
}

# ID de los archivos en Google Drive
$GOOGLE_DRIVE_FILE_ID = "COLOCA_AQUI_EL_ID_DEL_ZIP"  # TODO: Reemplazar con ID real
$GOOGLE_DRIVE_DOWNLOAD_URL = "https://drive.google.com/uc?export=download&id=$GOOGLE_DRIVE_FILE_ID"

# Carpeta temporal
$TempPath = Join-Path $env:TEMP "MyrientDM_Install_$(Get-Random)"
$ZipFile = Join-Path $TempPath "myrient-dm-complete.zip"

Write-Header "Instalador de Myrient Download Manager"

# Paso 1: Crear carpeta temporal
Write-Status "1️⃣ Preparando carpeta temporal..." "Info"
if (!(Test-Path $TempPath)) {
    New-Item -ItemType Directory -Path $TempPath -Force | Out-Null
    Write-Status "   ✓ Carpeta temporal creada" "Success"
} else {
    Write-Status "   ✓ Usando carpeta temporal existente" "Success"
}

# Paso 2: Descargar desde Google Drive
Write-Status "2️⃣ Descargando aplicación desde Google Drive..." "Info"
Write-Host "   Descargando: $GOOGLE_DRIVE_DOWNLOAD_URL" -ForegroundColor DarkGray

try {
    $ProgressPreference = 'SilentlyContinue'
    
    # Crear client HTTP
    $client = New-Object System.Net.Http.HttpClient
    $response = $client.GetAsync($GOOGLE_DRIVE_DOWNLOAD_URL).Result
    
    if ($response.IsSuccessStatusCode) {
        $fileStream = [System.IO.File]::Create($ZipFile)
        $contentStream = $response.Content.ReadAsStreamAsync().Result
        $contentStream.CopyToAsync($fileStream).Wait()
        $fileStream.Close()
        
        $fileSize = (Get-Item $ZipFile).Length / 1MB
        Write-Status "   ✓ Descarga completada ($([math]::Round($fileSize, 2)) MB)" "Success"
    } else {
        throw "Error en la descarga: $($response.StatusCode)"
    }
} catch {
    Write-Status "   ✗ Error descargando: $_" "Error"
    Write-Status "   Asegúrate de que:" "Warning"
    Write-Host "   1. El archivo está en Google Drive"
    Write-Host "   2. El ID del archivo es correcto"
    Write-Host "   3. Tienes conexión a Internet"
    exit 1
}

# Paso 3: Extraer ZIP
Write-Status "3️⃣ Extrayendo archivos..." "Info"
try {
    $ExtractPath = Join-Path $TempPath "extracted"
    Expand-Archive -Path $ZipFile -DestinationPath $ExtractPath -Force
    Write-Status "   ✓ Archivos extraídos" "Success"
} catch {
    Write-Status "   ✗ Error extrayendo: $_" "Error"
    if (!$SkipCleanup) {
        Remove-Item $TempPath -Recurse -Force
    }
    exit 1
}

# Paso 4: Buscar instalador
Write-Status "4️⃣ Buscando instalador..." "Info"
$SetupExe = Get-ChildItem -Path $ExtractPath -Filter "*.exe" -Recurse | Select-Object -First 1

if ($SetupExe) {
    Write-Status "   ✓ Instalador encontrado: $($SetupExe.Name)" "Success"
} else {
    Write-Status "   ✗ No se encontró el instalador" "Error"
    if (!$SkipCleanup) {
        Remove-Item $TempPath -Recurse -Force
    }
    exit 1
}

# Paso 5: Ejecutar instalador
Write-Status "5️⃣ Iniciando instalador..." "Info"
Write-Host "   Se abrirá el asistente de instalación en 3 segundos..." -ForegroundColor DarkGray
Start-Sleep -Seconds 3

try {
    Start-Process -FilePath $SetupExe.FullName -Wait -Verb RunAs
    Write-Status "   ✓ Instalador ejecutado" "Success"
} catch {
    Write-Status "   ✗ Error ejecutando instalador: $_" "Error"
    if (!$SkipCleanup) {
        Remove-Item $TempPath -Recurse -Force
    }
    exit 1
}

# Paso 6: Copiar base de datos (si existe)
Write-Status "6️⃣ Configurando base de datos..." "Info"
$DbArchive = Get-ChildItem -Path $ExtractPath -Filter "*.7z" -Recurse | Select-Object -First 1

if ($DbArchive) {
    $AppResourcePath = Join-Path $env:LOCALAPPDATA "Myrient Download Manager" "resources"
    
    if (!(Test-Path $AppResourcePath)) {
        New-Item -ItemType Directory -Path $AppResourcePath -Force | Out-Null
    }
    
    Copy-Item -Path $DbArchive.FullName -Destination $AppResourcePath -Force
    Write-Status "   ✓ Base de datos copiada" "Success"
} else {
    Write-Status "   ⚠ Base de datos no encontrada" "Warning"
}

# Paso 7: Limpiar archivos temporales
if (!$SkipCleanup) {
    Write-Status "7️⃣ Limpiando archivos temporales..." "Info"
    try {
        Remove-Item $TempPath -Recurse -Force
        Write-Status "   ✓ Limpieza completada" "Success"
    } catch {
        Write-Status "   ⚠ No se pudieron eliminar todos los archivos temporales" "Warning"
    }
}

# Finalización
Write-Header "✅ Instalación Completada"
Write-Status "La aplicación Myrient Download Manager ha sido instalada correctamente." "Success"
Write-Host ""
Write-Host "Próximos pasos:" -ForegroundColor Yellow
Write-Host "1. La aplicación aparecerá en tu menú Inicio"
Write-Host "2. En la primera ejecución, descargará la base de datos automáticamente"
Write-Host "3. ¡Disfruta explorando Myrient!"
Write-Host ""

Read-Host "Presiona Enter para cerrar esta ventana"
