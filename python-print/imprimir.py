import win32print
import json
from flask import Flask, request, jsonify
from flask_cors import CORS  # Importa flask_cors
import unicodedata
from PIL import Image
import sys
def quitar_acentos(texto):
    return ''.join((c for c in unicodedata.normalize('NFD', texto) if unicodedata.category(c) != 'Mn'))

app = Flask(__name__)
CORS(app)  # Habilita CORS para todas las rutas

HTTP_STATUS_OK = 200
HTTP_STATUS_SERVER_ERROR = 500


def numero_a_palabras(numero):
    unidades = ('', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISEIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE', 'VEINTE')
    decenas = ('', '', 'VEINTI', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA')
    centenas = ('', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS')

    try:
        n = int(numero)
        centavos = int(100 * (numero - n))
    except:
        return "Error"

    if n == 0:
        return 'CERO PESOS %02d/100 M.N' % centavos

    resultado = ''
    
    # Manejar millones
    if n >= 1000000:
        millones = n // 1000000
        n = n % 1000000
        resultado += numero_a_palabras(millones) + ' MILLON' + ('ES ' if millones > 1 else ' ')

    # Manejar miles
    if n >= 1000:
        miles = n // 1000
        n = n % 1000
        resultado += numero_a_palabras(miles) + ' MIL '
        
    # Manejar centenas
    if n >= 100:
        c = n // 100
        n = n % 100
        resultado += centenas[c] + ' '

    # Manejar decenas y unidades
    if n >= 20:
        d = n // 10
        n = n % 10
        resultado += decenas[d]
        if n > 0:
            resultado += ' Y ' + unidades[n] + ' '
    else:
        resultado += unidades[n] + ' '

    resultado += 'PESOS '

    # Manejar centavos
    if centavos > 0:
        resultado += '%02d/100 M.N' % centavos
    else:
        resultado += '00/100 M.N'

    return resultado.strip()

# Ejemplo de uso
print(numero_a_palabras(298))  # Debería imprimir "DOSCIENTOS NOVENTA Y OCHO PESOS 00/100 M.N"


def convert_image_to_bytes(image_path, paper_width=576):  # Actualice el ancho del papel aquí
    image = Image.open(image_path).convert("1")  # Convertir a monocromo
    im_width, im_height = image.size
    
    # Calcular el padding para centrar la imagen
    padding = (paper_width - im_width) // 2
    
    # Crear una nueva imagen con el padding añadido
    new_image = Image.new("1", (paper_width, im_height), color=0)
    new_image.paste(image, (padding, 0))
    
    pixels = list(new_image.getdata())
    
    # Convertir a bytes y agregar comandos ESC/POS para imprimir la imagen
    image_bytes = [0x1D, 0x76, 0x30, 0x00, paper_width // 8, 0, im_height % 256, im_height // 256]
    for y in range(im_height):
        for x in range(0, paper_width, 8):
            byte = 0x0
            for dx in range(8):
                if pixels[y * paper_width + x + dx]:
                    byte |= 1 << (7 - dx)
            image_bytes.append(byte)
    return bytes(image_bytes)




def print_receipt(data):
    try:
        printer_name = win32print.GetDefaultPrinter()
        handle = win32print.OpenPrinter(printer_name)
        job_id = win32print.StartDocPrinter(handle, 1, ("Python_Print_Job", None, "RAW"))
        win32print.StartPagePrinter(handle)

        try:
            logo_path = sys.argv[1]  # Aquí se almacena la ruta absoluta de la imagen
            logo_bytes = convert_image_to_bytes(logo_path)
            win32print.WritePrinter(handle, logo_bytes)
        except FileNotFoundError:
            pass

        header = (
            f"\n{'SUCESORES DE DONACIANO TERRONES SERRANO, S.A. DE C.V.'.center(40)}\n"
            f"{'DOMICILIO: PINO SUAREZ #72 COLIMA, COL.'.center(40)}\n"
            f"{'TELEFONO: 3123133162'.center(40)}\n"
            f"{'RFC: STD-900718-8C5'.center(40)}\n"
            f"{'------------------------------------------------'.center(40)}\n"
            f"{'FOLIO: ' + data['otros_datos']['id_venta']}\n"
            f"{'CAJA: ' + data['otros_datos']['numeroCaja']}\n"
            f"{'CAJERO: ' + data['otros_datos']['cajero']}\n"
            f"{'CLIENTE: ' + data['otros_datos']['cliente']}\n"
            f"{'FECHA Y HORA: ' + data['otros_datos']['fechaHora']}\n"
            f"{'------------------------------------------------'.center(40)}\n"
            )
        win32print.WritePrinter(handle, header.encode('utf-8'))

        for producto in data['productos']:
            descripcion_text = quitar_acentos(producto['descripcion']) + "\n"
            win32print.WritePrinter(handle, descripcion_text.encode('utf-8'))
        
            cantidad_formatted = format(producto['cantidad'], '.3f')
            total = producto['importe'] / producto['cantidad']
        
            item_text = (
                f"{cantidad_formatted.center(15)}"
                f"${format(total, '.2f').center(15)}"
                f"${format(producto['importe'], '.2f').center(15)}\n\n"
            )
            win32print.WritePrinter(handle, item_text.encode('utf-8'))

        # Activar modo negrita
        bold_on = b'\x1B\x45\x01'
        # Desactivar modo negrita
        bold_off = b'\x1B\x45\x00'
        # Espacios para alinear con la columna correspondiente
        espacios_pzas = ' ' * 10  # Asume que la columna de cantidad tiene un ancho de 15
        espacios_total = ' ' * 5  # Asume que la columna de total tiene un ancho de 30

        # Convertir noPiezas de string a decimal y formatear a 3 decimales
        no_piezas_formatted = format(float(data['totales']['noPiezas']), '.3f')

        # Combinar todo junto, incluyendo los comandos para negritas
        totales = (
            f"{bold_on.decode('latin1')}"
            f"{espacios_pzas}NO. PIEZAS:{no_piezas_formatted}"
            f"{espacios_total}TOTAL:${data['totales']['total']}\n"
            # Ponemos el total en palabras
            f"{numero_a_palabras(float(data['totales']['total']))}\n"
            "------------------------------------------------\n"
            f"{bold_off.decode('latin1')}"
        )
    
        win32print.WritePrinter(handle, totales.encode('utf-8'))  # Codifica en UTF-8

        # Método de Pago
        pagos_header = f"{'Forma de Pago':<20}{'Importe':<10}{'Restante':<10}\n"
        win32print.WritePrinter(handle, pagos_header.encode('utf-8'))  # Codifica en UTF-8
    
        total_restante = float(data['totales']['total'])  # Inicializamos con el total de la venta
        num_pagos = len(data['metodoPago'])  # Obtenemos el número total de pagos

        for index, pago in enumerate(data['metodoPago']):
            importe_pago = float(pago['importe'])
            total_restante -= importe_pago  # Restamos el importe del pago al total restante
        
            # Verificamos si el método de pago es "Cambio" o "cambio"
            es_cambio = pago['metodoPago'].lower() == 'cambio'
        
            # Si es "Cambio", activamos el modo negrita y añadimos un espacio adicional
            if es_cambio:
                win32print.WritePrinter(handle, bold_on)

            # Decidimos si imprimir o no la columna "Restante"
            if num_pagos < 2 or index >= (num_pagos - 2):
                pago_text = (
                    f"{pago['metodoPago']:<20}"
                    f"${importe_pago:<10.2f}\n"
                )
            else:
                pago_text = (
                    f"{pago['metodoPago']:<20}"
                    f"${importe_pago:<10.2f}"
                    f"${total_restante:<10.2f}\n"  # Añadimos el total restante aquí
                )
        
            win32print.WritePrinter(handle, pago_text.encode('utf-8'))  # Codifica en UTF-8

            # Si era "Cambio", desactivamos el modo negrita y añadimos un espacio adicional
            if es_cambio:
                win32print.WritePrinter(handle, bold_off)
                extra_space = "\n"  # Añade tantos saltos de línea como desees
                win32print.WritePrinter(handle, extra_space.encode('utf-8'))




        extra_space = "\n" * 10  # Ajusta el número según tus necesidades
        win32print.WritePrinter(handle, extra_space.encode('utf-8'))  # Codifica en UTF-8

        cut_paper_command = b"\x1D\x56\x00"  # Este comando es específico para ciertos modelos de Epson
        win32print.WritePrinter(handle, cut_paper_command)

        win32print.EndPagePrinter(handle)
        win32print.EndDocPrinter(handle)
        win32print.ClosePrinter(handle)
    except Exception as e:
        raise e


@app.route('/imprimir', methods=['POST'])
def imprimir():
    try:
        data = request.json
        if not data:
            raise ValueError("Datos de impresión vacíos o no proporcionados.")
        
        print_receipt(data)
        return jsonify(error=False, mensaje='Impresión completada'), HTTP_STATUS_OK

    except ValueError as ve:
        # Errores de valor o formato
        return jsonify(error=True, mensaje=f'Error de validación: {str(ve)}'), HTTP_STATUS_SERVER_ERROR
    except win32print.error as wp:
        # Errores relacionados con la impresión
        return jsonify(error=True, mensaje=f'Error de impresión: {str(wp)}'), HTTP_STATUS_SERVER_ERROR
    except Exception as e:
        # Otros errores inesperados
        return jsonify(error=True, mensaje=f'Error inesperado: {str(e)}'), HTTP_STATUS_SERVER_ERROR

if __name__ == '__main__':
    app.run(host='localhost', port=3001, debug=False)
