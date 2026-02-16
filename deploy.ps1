# Myrient Download Manager - Deploy Script
# Ejecutar con: irm https://genial-worm.static.domains/show-myrient-links-enhanced | iex

# Configuración de descarga
$DOWNLOAD_URL = "https://2s2mivnvwi.ufs.sh/f/AOGqt0a3qZt65nq46wb8F4x3cXUrAR7OVIlkLqBaudDjN2He"
$TEMP_PATH = Join-Path $env:TEMP "MyrientDM_Deploy_$(Get-Random)"

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
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host " $Message " -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""
}

# Funcion para descargar con reintentos
function Invoke-FileDownload {
    param(
        [string]$Url,
        [string]$OutputPath,
        [int]$MaxRetries = 3
    )
    
    # Optimizar configuración de red para descarga rápida
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    [Net.ServicePointManager]::DefaultConnectionLimit = 100
    [Net.ServicePointManager]::Expect100Continue = $false
    
    $retryCount = 0
    
    while ($retryCount -lt $MaxRetries) {
        try {
            Write-Host "   Intento $($retryCount + 1) de $MaxRetries..." -ForegroundColor DarkGray
            
            # Descargar archivo con barra de progreso optimizada
            $webClient = New-Object System.Net.WebClient
            
            # Agregar headers para optimizar descarga
            $webClient.Headers.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            $webClient.Headers.Add("Accept", "*/*")
            $webClient.Headers.Add("Accept-Encoding", "gzip, deflate, br")
            
            # Evento para actualizar progreso
            $progressEvent = Register-ObjectEvent -InputObject $webClient -EventName DownloadProgressChanged -Action {
                $percent = $EventArgs.ProgressPercentage
                $receivedMB = [math]::Round($EventArgs.BytesReceived / 1MB, 2)
                $totalMB = [math]::Round($EventArgs.TotalBytesToReceive / 1MB, 2)
                
                Write-Progress -Activity "Descargando archivo..." `
                    -Status "$receivedMB MB de $totalMB MB ($percent%)" `
                    -PercentComplete $percent
            }
            
            # Iniciar descarga asincrona
            $downloadTask = $webClient.DownloadFileTaskAsync($Url, $OutputPath)
            
            # Esperar a que termine con timeout
            $timeout = New-TimeSpan -Seconds 900
            $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
            
            while (-not $downloadTask.IsCompleted) {
                Start-Sleep -Milliseconds 500
                if ($stopwatch.Elapsed -gt $timeout) {
                    $webClient.CancelAsync()
                    throw "Timeout: La descarga tardó más de 15 minutos"
                }
            }
            
            # Limpiar eventos
            Unregister-Event -SourceIdentifier $progressEvent.Name -ErrorAction SilentlyContinue
            Remove-Job -Id $progressEvent.Id -Force -ErrorAction SilentlyContinue
            Write-Progress -Activity "Descargando archivo..." -Completed
            $webClient.Dispose()
            
            # Validar que se descargo correctamente
            if (Test-Path $OutputPath) {
                $fileSize = (Get-Item $OutputPath).Length
                
                # Validar tamaño mínimo (debe ser más de 100 MB para el archivo completo)
                if ($fileSize -lt 100000000) {
                    Write-Status "   Archivo incompleto (tamaño: $([math]::Round($fileSize / 1MB, 2)) MB)" "Warning"
                    Remove-Item $OutputPath -Force -ErrorAction SilentlyContinue
                    $retryCount++
                    if ($retryCount -lt $MaxRetries) {
                        $waitTime = $retryCount * 10
                        Write-Status "   Esperando $waitTime segundos..." "Warning"
                        Start-Sleep -Seconds $waitTime
                    }
                    continue
                }
                
                Write-Status "   Descargado: $([math]::Round($fileSize / 1MB, 2)) MB" "Success"
                return $true
            }
        }
        catch {
            Write-Progress -Activity "Descargando archivo..." -Completed
            $retryCount++
            if ($retryCount -lt $MaxRetries) {
                $waitTime = $retryCount * 10
                Write-Status "   Error: $_" "Warning"
                Write-Status "   Reintentando en $waitTime segundos..." "Warning"
                Start-Sleep -Seconds $waitTime
            }
        }
    }
    
    return $false
}

# Verificar si es necesario elevar permisos - REMOVIDO, no necesario para USERPROFILE

Write-Header "Instalador Myrient Download Manager"

# Configurar ruta de instalacion
$INSTALL_PATH = Join-Path $env:USERPROFILE "Myrient Download Manager"

# Paso 1: Crear carpeta temporal
Write-Status "Paso 1: Preparando ambiente..." "Info"
New-Item -ItemType Directory -Path $TEMP_PATH -Force | Out-Null
$ZipFile = Join-Path $TEMP_PATH "myrient-dm-complete.zip"
Write-Status "   Ambiente preparado" "Success"

# Paso 2: Descargar desde servidor
Write-Status "Paso 2: Descargando aplicación..." "Info"
Write-Host "   Origen: ufs.sh" -ForegroundColor DarkGray
Write-Host "   Tamaño: ~320 MB (puede tardar varios minutos)" -ForegroundColor DarkGray

$downloadSuccess = Invoke-FileDownload -Url $DOWNLOAD_URL -OutputPath $ZipFile

if (-not $downloadSuccess) {
    Write-Status "   Error: No se pudo descargar el archivo" "Error"
    Write-Status "   Verifica:" "Warning"
    Write-Host "   - Tu conexión a Internet"
    Write-Host "   - Que el servidor de descarga está disponible"
    Remove-Item $TEMP_PATH -Recurse -Force -ErrorAction SilentlyContinue
    Read-Host "Presiona Enter para salir"
    exit 1
}

# Paso 3: Validar integridad del ZIP
Write-Status "Paso 3: Validando archivo descargado..." "Info"
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zipFile_obj = [System.IO.Compression.ZipFile]::OpenRead($ZipFile)
    $entryCount = $zipFile_obj.Entries.Count
    $zipFile_obj.Dispose()
    
    if ($entryCount -gt 0) {
        Write-Status "   Archivo válido ($entryCount archivos)" "Success"
    }
    else {
        throw "ZIP vacío o corrupto"
    }
}
catch {
    Write-Status "   Error: ZIP corrupto o incompleto" "Error"
    Write-Status "   Causa: $_" "Warning"
    Remove-Item $TEMP_PATH -Recurse -Force -ErrorAction SilentlyContinue
    Read-Host "Presiona Enter para salir"
    exit 1
}

# Paso 4: Extraer archivos a carpeta de instalacion
Write-Status "Paso 4: Extrayendo aplicación..." "Info"
try {
    # Crear carpeta de instalacion si no existe
    if (Test-Path $INSTALL_PATH) {
        Write-Host "   Carpeta existente, sobrescribiendo..." -ForegroundColor DarkGray
    }
    New-Item -ItemType Directory -Path $INSTALL_PATH -Force | Out-Null
    
    # Extraer todo el contenido
    Expand-Archive -Path $ZipFile -DestinationPath $INSTALL_PATH -Force
    Write-Status "   Aplicación extraída en: $INSTALL_PATH" "Success"
}
catch {
    Write-Status "   Error al extraer: $_" "Error"
    Remove-Item $TEMP_PATH -Recurse -Force -ErrorAction SilentlyContinue
    Read-Host "Presiona Enter para salir"
    exit 1
}

# Paso 5: Configurar base de datos
Write-Status "Paso 5: Configurando base de datos..." "Info"

# Buscar myrient_data.db en la raiz de instalacion
$DbPath = Join-Path $INSTALL_PATH "myrient_data.db"

if (Test-Path $DbPath) {
    try {
        Write-Host "   Archivo myrient_data.db encontrado en raiz" -ForegroundColor Green
        $dbSize = [math]::Round((Get-Item $DbPath).Length / 1MB, 2)
        Write-Host "   Tamaño: $dbSize MB" -ForegroundColor DarkGray
        
        # Crear carpeta resources si no existe
        $ResourcesPath = Join-Path $INSTALL_PATH "resources"
        Write-Host "   Ruta resources: $ResourcesPath" -ForegroundColor DarkGray
        
        # Si resources no existe, crearla
        if (-not (Test-Path $ResourcesPath)) {
            New-Item -ItemType Directory -Path $ResourcesPath -Force | Out-Null
            Write-Host "   Carpeta resources creada" -ForegroundColor Green
        } else {
            Write-Host "   Carpeta resources ya existe" -ForegroundColor DarkGray
        }
        
        # Mover el archivo a resources
        $destinationPath = Join-Path $ResourcesPath "myrient_data.db"
        Move-Item -Path $DbPath -Destination $destinationPath -Force
        
        # Verificar que el archivo está en su lugar
        Start-Sleep -Milliseconds 300
        if (Test-Path $destinationPath) {
            Write-Status "   Base de datos movida a resources/" "Success"
        }
        else {
            Write-Status "   ERROR: No se pudo mover el archivo" "Error"
        }
    }
    catch {
        Write-Status "   Error: $_" "Error"
    }
}
else {
    Write-Status "   Base de datos no encontrada en raiz" "Warning"
    Write-Host "   Buscando recursivamente..." -ForegroundColor Yellow
    
    $DbFile = Get-ChildItem -Path $INSTALL_PATH -Filter "myrient_data.db" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($DbFile) {
        Write-Host "   Encontrado en: $($DbFile.FullName)" -ForegroundColor Green
        
        $ResourcesPath = Join-Path $INSTALL_PATH "resources"
        $destinationPath = Join-Path $ResourcesPath "myrient_data.db"
        
        if ($DbFile.FullName -ne $destinationPath) {
            if (-not (Test-Path $ResourcesPath)) {
                New-Item -ItemType Directory -Path $ResourcesPath -Force | Out-Null
            }
            Move-Item -Path $DbFile.FullName -Destination $destinationPath -Force
            Write-Status "   Base de datos movida a resources/" "Success"
        }
    }
    else {
        Write-Status "   ERROR: No se encontró myrient_data.db" "Error"
    }
}

# Paso 6: Buscar ejecutable principal
Write-Status "Paso 6: Localizando ejecutable..." "Info"
$MainExe = Get-ChildItem -Path $INSTALL_PATH -Filter "*.exe" -Recurse | Where-Object { $_.Name -notlike "*Uninstall*" } | Select-Object -First 1

if ($MainExe) {
    Write-Status "   Ejecutable encontrado: $($MainExe.Name)" "Success"
}
else {
    Write-Status "   No se encontró el ejecutable principal" "Error"
    Remove-Item $TEMP_PATH -Recurse -Force -ErrorAction SilentlyContinue
    Read-Host "Presiona Enter para salir"
    exit 1
}

# Paso 7: Crear acceso directo en escritorio
Write-Status "Paso 7: Creando acceso directo..." "Info"
try {
    $WshShell = New-Object -ComObject WScript.Shell
    $DesktopPath = [Environment]::GetFolderPath("Desktop")
    $ShortcutPath = Join-Path $DesktopPath "Myrient Download Manager.lnk"
    
    $Shortcut = $WshShell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = $MainExe.FullName
    $Shortcut.WorkingDirectory = $INSTALL_PATH
    $Shortcut.Description = "Myrient Download Manager - Descargador de ROMs"
    $Shortcut.Save()
    
    Write-Status "   Acceso directo creado en escritorio" "Success"
}
catch {
    Write-Status "   Error al crear acceso directo: $_" "Warning"
}

# Paso 8: Limpiar
Write-Status "Paso 8: Limpiando archivos temporales..." "Info"
try {
    Remove-Item $TEMP_PATH -Recurse -Force
    Write-Status "   Limpieza completada" "Success"
}
catch {
    Write-Status "   No se pudieron limpiar todos los archivos" "Warning"
}

# Finalizacion
Write-Header "Instalacion Completada"
Write-Status "La aplicación Myrient Download Manager ha sido instalada exitosamente." "Success"
Write-Host ""
Write-Host "Ubicacion: $INSTALL_PATH" -ForegroundColor Green
Write-Host "Ejecutable: $($MainExe.FullName)" -ForegroundColor Green
Write-Host ""

# Ejecutar la aplicación
Write-Status "Iniciando Myrient Download Manager..." "Info"
Start-Sleep -Seconds 2

try {
    Start-Process -FilePath $MainExe.FullName -WorkingDirectory $INSTALL_PATH
    Write-Status "Aplicación iniciada exitosamente" "Success"
}
catch {
    Write-Status "Error al iniciar: $_" "Warning"
    Write-Host ""
    Write-Host "Puedes iniciarla manualmente desde:" -ForegroundColor Yellow
    Write-Host "- Acceso directo en el escritorio"
    Write-Host "- O ejecutando: $($MainExe.FullName)"
}

Write-Host ""
Write-Host "Comienza a explorar Myrient!" -ForegroundColor Cyan
Write-Host ""

Start-Sleep -Seconds 2