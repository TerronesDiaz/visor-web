document.addEventListener('DOMContentLoaded', function () {
    var downloadButton = document.getElementById('downloadButton');
    var downloadArrow = document.getElementById('downloadArrow');

    downloadButton.addEventListener('click', function () {
        downloadButton.innerHTML = 'Descargando... <i class="fas fa-spinner fa-spin"></i>';
        downloadButton.disabled = true; 

        downloadArrow.style.display = 'block'; // Muestra la flecha

        setTimeout(function() {
            downloadButton.innerHTML = 'Descargar';
            downloadButton.disabled = false;
            downloadArrow.style.display = 'none'; // Oculta la flecha después de un tiempo
            window.location.href = 'descargar.php'; // Inicia la descarga
        }, 3000); // Muestra la flecha durante 3 segundos
    });
});
