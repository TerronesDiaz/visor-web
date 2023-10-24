import win32print
import win32api
import logging
import json
from flask import Flask, request, jsonify
from flask_cors import CORS  # Importa flask_cors
import unicodedata
from PIL import Image
import sys
import datetime
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


def validar_datos(data):
    # Verificar que los datos no estén vacíos
    if not data:
        return False, "Datos de impresión vacíos o no proporcionados."

    # Verificar la existencia de campos clave
    campos_requeridos = ['otros_datos', 'productos', 'totales', 'metodoPago']
    for campo in campos_requeridos:
        if campo not in data:
            return False, f"Falta el campo {campo}"

    # Validar el campo 'otros_datos'
    otros_datos_requeridos = ['id_venta', 'numeroCaja', 'cajero', 'cliente', 'fechaHora']
    for campo in otros_datos_requeridos:
        if campo not in data['otros_datos']:
            return False, f"Falta el campo {campo} en otros_datos"

    # Validar el campo 'productos'
    if not data['productos']:
        return False, "La lista de productos está vacía."
    for producto in data['productos']:
        if 'descripcion' not in producto or 'cantidad' not in producto or 'importe' not in producto:
            return False, "Falta algún campo en la lista de productos."

    # Validar el campo 'totales'
    totales_requeridos = ['noPiezas', 'total']
    for campo in totales_requeridos:
        if campo not in data['totales']:
            return False, f"Falta el campo {campo} en totales"

    # Validar el campo 'metodoPago'
    if not data['metodoPago']:
        return False, "La lista de métodos de pago está vacía."
    for pago in data['metodoPago']:
        if 'metodoPago' not in pago or 'importe' not in pago:
            return False, "Falta algún campo en la lista de métodos de pago."

    return True, "Datos válidos"
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

        # Si existe data.concepto y no está vacío ni es null, lo imprimimos
        if 'concepto' in data and data['concepto']:
            concepto_text = f"CONCEPTO: {data['concepto']}\n"
            win32print.WritePrinter(handle, concepto_text.encode('utf-8'))  # Codifica en UTF-8
            


        extra_space = "\n" * 10  # Ajusta el número según tus necesidades
        win32print.WritePrinter(handle, extra_space.encode('utf-8'))  # Codifica en UTF-8

        cut_paper_command = b"\x1D\x56\x00"  # Este comando es específico para ciertos modelos de Epson
        win32print.WritePrinter(handle, cut_paper_command)

        win32print.EndPagePrinter(handle)
        win32print.EndDocPrinter(handle)
        win32print.ClosePrinter(handle)
    except Exception as e:
        raise e

# Configura el sistema de registro
logging.basicConfig(filename='error_log_python.txt', level=logging.ERROR, format='%(asctime)s - %(message)s')

def validate_cashier_cut_data(data):
    try:
        required_fields = [
            'tipo_corte', 
            'id_corte', 
            'id_caja', 
            'id_cajero', 
            'nombre_cajero', 
            'fecha_corte', 
            'hora_corte',
            'sumas_generales',
            'sumas_por_forma_pago',
            'saldo_inicial'
        ]
        
        # Verifica que todos los campos requeridos existan
        for field in required_fields:
            if field not in data:
                logging.error(f"Campo requerido '{field}' no encontrado en los datos.")
                return {'error': True, 'mensaje': f"Campo requerido '{field}' no encontrado en los datos."}
        
        # Intenta corregir el tipo de los campos numéricos
        for field in ['id_corte', 'id_caja', 'id_cajero', 'saldo_inicial']:
            try:
                data[field] = int(data[field])
            except ValueError:
                logging.error(f"Campo '{field}' no puede ser convertido a entero.")
                return {'error': True, 'mensaje': f"Campo '{field}' no puede ser convertido a entero."}
            
        # Intenta normalizar el formato de la fecha y la hora
        try:
            fecha_dt = datetime.datetime.strptime(data['fecha_corte'], '%Y-%m-%d')
            data['fecha_corte'] = fecha_dt.strftime('%d-%m-%Y')
        except ValueError:
            try:
                fecha_dt = datetime.datetime.strptime(data['fecha_corte'], '%d-%m-%Y')
                data['fecha_corte'] = fecha_dt.strftime('%d-%m-%Y')
            except ValueError:
                logging.error("Formato de fecha incorrecto. No se puede transformar a DD-MM-YYYY.")
                return {'error': True, 'mensaje': "Formato de fecha incorrecto. No se puede transformar a DD-MM-YYYY."}
        
        try:
            hora_dt = datetime.datetime.strptime(data['hora_corte'], '%H:%M')
            data['hora_corte'] = hora_dt.strftime('%I:%M %p')
        except ValueError:
            try:
                hora_dt = datetime.datetime.strptime(data['hora_corte'], '%I:%M %p')
                data['hora_corte'] = hora_dt.strftime('%I:%M %p')
            except ValueError:
                logging.error("Formato de hora incorrecto. No se puede transformar a formato de 12 horas.")
                return {'error': True, 'mensaje': "Formato de hora incorrecto. No se puede transformar a formato de 12 horas."}
            
        # Verifica que sumas_generales tenga los campos necesarios
        sumas_generales_fields = ['subtotal', 'descuento', 'iva', 'ieps', 'total']
        for field in sumas_generales_fields:
            if field not in data['sumas_generales']:
                logging.error(f"Campo requerido 'sumas_generales.{field}' no encontrado en los datos.")
                return {'error': True, 'mensaje': f"Campo requerido 'sumas_generales.{field}' no encontrado en los datos."}
        
        # Verifica que cada objeto en sumas_por_forma_pago tenga los campos necesarios
        forma_pago_fields = ['nombre_forma_pago', 'suma_total', 'suma_iva', 'suma_ieps']
        for forma_pago in data['sumas_por_forma_pago']:
            for field in forma_pago_fields:
                if field not in forma_pago:
                    logging.error(f"Campo requerido 'sumas_por_forma_pago.{field}' no encontrado en los datos.")
                    return {'error': True, 'mensaje': f"Campo requerido 'sumas_por_forma_pago.{field}' no encontrado en los datos."}
        
        logging.info("Validación exitosa")
        return {'error': False, 'mensaje': 'Validación exitosa'}
    except Exception as e:
        logging.error(f'Error desconocido: {str(e)}')
        return {'error': True, 'mensaje': f'Error desconocido en la validación de corte: {str(e)}'}

def print_cashier_cut(data):
    try:
        printer_name = win32print.GetDefaultPrinter()
        handle = win32print.OpenPrinter(printer_name)
        job_id = win32print.StartDocPrinter(handle, 1, ("Python_Print_Job", None, "RAW"))
        win32print.StartPagePrinter(handle)
        font_large_bold = b'\x1B\x21\x00'
        font_normal = b'\x1B\x21\x00'
        logo_path = sys.argv[1]
        logo_bytes = convert_image_to_bytes(logo_path)
        win32print.WritePrinter(handle, logo_bytes)
    except FileNotFoundError:
        logging.error("Excepción: FileNotFoundError")
    except Exception as e:
        logging.error(f"Error desconocido al manejar el logo: {e}")
        return {'error': True, 'mensaje': str(e)}

    try:
        header = (
            f"\n{'SUCESORES DE DONACIANO TERRONES SERRANO, S.A. DE C.V.'.center(40)}\n"
            f"{'DOMICILIO: PINO SUAREZ #72 COLIMA, COL.'.center(40)}\n"
            f"{'TELEFONO: 3123133162'.center(40)}\n"
            f"{'RFC: STD-900718-8C5'.center(40)}\n"
            f"{'------------------------------------------------'.center(40)}\n"
            f"{'CORTE DE CAJA':<20}\n"
            f"{'TIPO DE CORTE: ' + data['tipo_corte']}\n"
            f"{'ID_CORTE: ' + str(data['id_corte'])}\n"
            f"{'ID CAJA: ' + str(data['id_caja'])}\n"
            f"{'ID CAJERO: ' + str(data['id_cajero'])}\n"
            f"{'CAJERO: ' + data['nombre_cajero']}\n"
            f"{'FECHA: ' + data['fecha_corte']}\n"
            f"{'HORA: ' + data['hora_corte']}\n"
            f"{'------------------------------------------------'.center(40)}\n"
        )
        win32print.WritePrinter(handle, header.encode('utf-8'))
    except Exception as e:
        logging.error(f"Error al imprimir el encabezado: {e}")
        return {'error': True, 'mensaje': str(e)}

    try:
        accumulated_total = 0
        for forma_pago in data['sumas_por_forma_pago']:
            forma_pago_total = forma_pago['suma_total']
            accumulated_total += float(forma_pago_total)
            nombre_sin_acentos = quitar_acentos(forma_pago['nombre_forma_pago'])
            forma_pago_text = (
                font_large_bold +
                f"{nombre_sin_acentos.upper().center(40)}\n".encode('utf-8') +
                font_normal +
                f"{'IEPS: ':<15}${forma_pago['suma_ieps']:>15}\n"
                f"{'IVA: ':<15}${forma_pago['suma_iva']:>15}\n".encode('utf-8') +
                font_large_bold +
                f"{'TOTAL: ':<15}${forma_pago_total:>15} +   ${accumulated_total:>15}\n".encode('utf-8') +
                font_normal +
                f"{'------------------------------------------------'.center(40)}\n".encode('utf-8')
            )
            win32print.WritePrinter(handle, forma_pago_text)
    except Exception as e:
        logging.error(f"Error al imprimir sumas por forma de pago: {e}")
        return {'error': True, 'mensaje': str(e)}

    try:
        sumas_generales = (
            font_large_bold +
            f"{'TOTAL'.center(40)}\n".encode('utf-8') +
            font_normal +
            f"{'IEPS_TOTAL: ':<20}${data['sumas_generales']['ieps']:>20}\n".encode('utf-8') +
            f"{'IVA_TOTAL: ':<20}${data['sumas_generales']['iva']:>20}\n".encode('utf-8') +
            f"{'TOTAL CORTE: ':<20}${data['sumas_generales']['total']:>20}\n".encode('utf-8') +
            f"{'------------------------------------------------'.center(40)}\n".encode('utf-8') +
            f"{'SALDO INICIAL: ':<20}${data['saldo_inicial']:>20}\n".encode('utf-8') +
            font_large_bold +
            f"{'TOTAL CORTE + SALDO INICIAL: ':<20}${data['sumas_generales']['total'] + data['saldo_inicial']:>20}\n".encode('utf-8') +
            font_normal +
            f"{'------------------------------------------------'.center(40)}\n".encode('utf-8')
        )
        win32print.WritePrinter(handle, sumas_generales)
    except Exception as e:
        logging.error(f"Error al imprimir sumas generales: {e}")
        return {'error': True, 'mensaje': str(e)}

    try:
        extra_space = "\n" * 10
        win32print.WritePrinter(handle, extra_space.encode('utf-8'))
        cut_paper_command = b"\x1D\x56\x00"
        win32print.WritePrinter(handle, cut_paper_command)
    except Exception as e:
        logging.error(f"Error al imprimir el espacio extra o cortar el papel: {e}")
        return {'error': True, 'mensaje': str(e)}

    try:
        win32print.EndPagePrinter(handle)
        win32print.EndDocPrinter(handle)
        win32print.ClosePrinter(handle)
    except Exception as e:
        logging.error(f"Error al finalizar el trabajo de impresión: {e}")
        return {'error': True, 'mensaje': str(e)}

    return {'error': False, 'mensaje': 'Impresión completada con éxito'}


#Función para imprimir un ticket de venta	

@app.route('/imprimir', methods=['POST'])
def imprimir():
    try:
        data = request.json
        if not data:
            raise ValueError("Datos de impresión vacíos o no proporcionados.")
        
        valido, mensaje = validar_datos(data)
        if not valido:
           raise ValueError(mensaje)
        
        print_receipt(data)

        #Si existe una propiedad data.openDrawer y es true, se abre el cajón
        if 'openDrawer' in data and data['openDrawer']:
            printer_name = win32print.GetDefaultPrinter()
            handle = win32print.OpenPrinter(printer_name)
            open_drawer_command = b'\x1B\x70\x00\x19\xFA'  # Este comando es específico para ciertos modelos de Epson
            win32print.StartDocPrinter(handle, 1, ("Python_Print_Job", None, "RAW"))
            win32print.StartPagePrinter(handle)
            win32print.WritePrinter(handle, open_drawer_command)
            win32print.EndPagePrinter(handle)
            win32print.EndDocPrinter(handle)
            win32print.ClosePrinter(handle)

        return jsonify(error=False, mensaje='Impresión completada'), HTTP_STATUS_OK

    except ValueError as ve:
        # Errores de valor o formato
        return jsonify(error=True, mensaje=f'Error de validación: {str(ve)}'), HTTP_STATUS_SERVER_ERROR
    except win32print.error as wp:
        # Errores relacionados con la impresión
        return jsonify(error=True, mensaje=f'Error de impresión: {str(wp)}'), HTTP_STATUS_SERVER_ERROR
    except Exception as e:
        # Otros errores inesperados
        return jsonify(error=True, mensaje=f'Error inesperado i: {str(e)}'), HTTP_STATUS_SERVER_ERROR

#Función para abrir el cajón de dinero
@app.route('/abrirCajon', methods=['POST'])
def abrirCajon():
    try:
        data = request.json
        if not data or 'openDrawer' not in data or not data['openDrawer']:
            return jsonify(error=True, mensaje='Parámetro openDrawer no proporcionado o falso'), HTTP_STATUS_SERVER_ERROR
        
        # Obtener el nombre de la impresora predeterminada
        printer_name = win32print.GetDefaultPrinter()
        # Abrir la impresora
        handle = win32print.OpenPrinter(printer_name)
        # Comando para abrir el cajón. Específico para ciertos modelos de Epson.
        open_drawer_command = b'\x1B\x70\x00\x19\xFA'
        # Iniciar un nuevo trabajo de impresión
        win32print.StartDocPrinter(handle, 1, ("Python_Drawer_Open_Job", None, "RAW"))
        # Iniciar una nueva página
        win32print.StartPagePrinter(handle)
        # Enviar el comando para abrir el cajón
        win32print.WritePrinter(handle, open_drawer_command)
        # Finalizar la página
        win32print.EndPagePrinter(handle)
        # Finalizar el trabajo de impresión
        win32print.EndDocPrinter(handle)
        # Cerrar la impresora
        win32print.ClosePrinter(handle)
        return jsonify(error=False, mensaje='Cajón abierto con éxito'), HTTP_STATUS_OK
    except win32print.error as wp:
        return jsonify(error=True, mensaje=f'Error al abrir el cajón: {str(wp)}'), HTTP_STATUS_SERVER_ERROR
    except Exception as e:
        return jsonify(error=True, mensaje=f'Error inesperado ac: {str(e)}'), HTTP_STATUS_SERVER_ERROR

@app.route('/imprimirCorte', methods=['POST'])
def imprimirCorte():
    handle = None
    try:
        data = request.json
        if not data:
            raise ValueError("Datos de impresión vacíos o no proporcionados.")
        
        validation_result = validate_cashier_cut_data(data)  # Almacena el resultado de la validación
        
        if validation_result['error']:
            return jsonify(error=True, mensaje=validation_result['mensaje']), HTTP_STATUS_SERVER_ERROR
        
        # Continúa con la impresión solo si no hay errores de validación
        print_result = print_cashier_cut(data)
        if print_result['error']:
            return jsonify(error=True, mensaje=print_result['mensaje']), HTTP_STATUS_SERVER_ERROR

        if 'openDrawer' in data and data['openDrawer']:
            printer_name = win32print.GetDefaultPrinter()
            handle = win32print.OpenPrinter(printer_name)
            open_drawer_command = b'\x1B\x70\x00\x19\xFA'
            win32print.StartDocPrinter(handle, 1, ("Python_Print_Job", None, "RAW"))
            win32print.StartPagePrinter(handle)
            win32print.WritePrinter(handle, open_drawer_command)
            win32print.EndPagePrinter(handle)
            win32print.EndDocPrinter(handle)

        return jsonify(error=False, mensaje='Impresión completada'), HTTP_STATUS_OK

    except ValueError as ve:
        # Errores de valor o formato
        return jsonify(error=True, mensaje=f'Error de validación: {str(ve)}'), HTTP_STATUS_SERVER_ERROR
    except Exception as e:  # Captura cualquier otra excepción aquí
        # Errores relacionados con la impresión u otros errores inesperados
        return jsonify(error=True, mensaje=f'Error inesperado ic: {str(e)}'), HTTP_STATUS_SERVER_ERROR
    finally:
        if handle:
            win32print.ClosePrinter(handle)
if __name__ == '__main__':
    app.run(host='localhost', port=3001, debug=False)
