<?php
// Directorio donde se encuentran los archivos
$directorio = '../'; // Asegúrese de que esta ruta sea relativa a la ubicación del script PHP

// Encuentra el archivo más reciente que coincide con el patrón
$archivos = glob($directorio . 'visor-web Setup *.exe'); // ajuste este patrón si es necesario
$archivoReciente = null;

if ($archivos) {
    // Ordenamos los archivos por fecha de modificación descendente
    usort($archivos, function ($a, $b) {
        return filemtime($b) - filemtime($a);
    });

    // El archivo más reciente estará en la primera posición
    $archivoReciente = $archivos[0];
}

// Asegúrese de que el archivo existe
if ($archivoReciente && file_exists($archivoReciente)) {
    // Establezca los headers adecuados para la descarga
    header('Content-Description: File Transfer');
    header('Content-Type: application/octet-stream');
    header('Content-Disposition: attachment; filename="'.basename($archivoReciente).'"');
    header('Expires: 0');
    header('Cache-Control: must-revalidate');
    header('Pragma: public');
    header('Content-Length: ' . filesize($archivoReciente));
    
    // Limpie el sistema de buffers de salida
    flush();
    
    // Lea el archivo y escríbalo en el buffer de salida
    readfile($archivoReciente);
    
    exit;
} else {
    echo "Error: No se encontró la versión más reciente del archivo.";
}
?>
