"""Formatos de ticket para cuentas por cobrar y el pagaré de ventas a crédito.

Funciones puras: reciben los datos que manda el POS y devuelven los bytes
ESC/POS, sin tocar la impresora, para poder probarlas sin hardware.

Las impresoras térmicas no interpretan UTF-8: los acentos salían como basura
("PAGARÃ‰"). Todo el texto se convierte a ASCII y los párrafos se cortan entre
palabras al ancho del papel de 80 mm (48 caracteres con la fuente normal).
"""

import textwrap
import unicodedata

ANCHO = 48

NEGRITA_ON = b'\x1b\x45\x01'
NEGRITA_OFF = b'\x1b\x45\x00'
DOBLE_ALTO_ON = b'\x1d\x21\x01'  # Doble alto: conserva los 48 caracteres por renglón.
TAMANO_NORMAL = b'\x1d\x21\x00'
CENTRAR = b'\x1b\x61\x01'
IZQUIERDA = b'\x1b\x61\x00'
AVANCE_Y_CORTE = b'\n' * 10 + b'\x1d\x56\x00'

_SUSTITUTOS = {
    '¿': '', '¡': '', '“': '"', '”': '"', '‘': "'", '’': "'",
    '–': '-', '—': '-', '°': 'o', 'º': 'o', 'ª': 'a', '€': 'EUR',
}


def a_ascii(texto):
    """Quita acentos y reemplaza lo que la impresora no puede imprimir."""
    texto = ''.join(_SUSTITUTOS.get(c, c) for c in str(texto if texto is not None else ''))
    texto = ''.join(c for c in unicodedata.normalize('NFD', texto) if unicodedata.category(c) != 'Mn')
    return texto.encode('ascii', 'replace').decode('ascii')


def dinero(valor):
    return f"${float(valor):,.2f}"


def _renglon(texto=''):
    return a_ascii(texto).encode('ascii') + b'\n'


def _parrafo(texto, sangria=''):
    """Párrafo cortado entre palabras al ancho del ticket."""
    lineas = textwrap.wrap(a_ascii(texto), width=ANCHO, initial_indent=sangria, subsequent_indent=sangria) or ['']
    return b''.join(linea.encode('ascii') + b'\n' for linea in lineas)


def _par(izquierda, derecha):
    """Etiqueta a la izquierda y valor a la derecha en un renglón."""
    izquierda, derecha = a_ascii(izquierda), a_ascii(derecha)
    espacio = ANCHO - len(izquierda) - len(derecha)
    if espacio < 1:
        return _parrafo(izquierda) + (derecha.rjust(ANCHO)).encode('ascii') + b'\n'
    return (izquierda + ' ' * espacio + derecha).encode('ascii') + b'\n'


def _separador(caracter='-'):
    return (caracter * ANCHO).encode('ascii') + b'\n'


def _titulo(texto):
    return CENTRAR + NEGRITA_ON + DOBLE_ALTO_ON + _renglon(texto) + TAMANO_NORMAL + NEGRITA_OFF + IZQUIERDA


def encabezado_empresa(empresa):
    empresa = empresa or {}
    partes_domicilio = [
        f"{empresa.get('calle', '')} {empresa.get('numero', '')}".strip(),
        f"COL. {empresa['colonia']}" if empresa.get('colonia') else '',
        empresa.get('municipio', ''),
        empresa.get('estado', ''),
    ]
    domicilio = ', '.join(p for p in partes_domicilio if p)
    salida = CENTRAR + NEGRITA_ON + _parrafo(empresa.get('nombre_empresa', '')) + NEGRITA_OFF
    if domicilio:
        salida += _parrafo(domicilio)
    contacto = '   '.join(p for p in [
        f"TEL: {empresa['telefono']}" if empresa.get('telefono') else '',
        f"RFC: {empresa['rfc']}" if empresa.get('rfc') else '',
    ] if p)
    if contacto:
        salida += _parrafo(contacto)
    return salida + IZQUIERDA + _separador()


def validar_abono(data):
    if not isinstance(data, dict):
        return False, 'Datos del comprobante vacíos.'
    for campo in ('abono', 'cliente', 'documentos', 'saldo_pendiente_cliente'):
        if campo not in data:
            return False, f'Falta el campo {campo}.'
    for campo in ('folio', 'fecha', 'importe', 'forma_pago'):
        if campo not in data['abono']:
            return False, f'Falta el campo abono.{campo}.'
    if not data['documentos']:
        return False, 'El abono no tiene documentos aplicados.'
    for documento in data['documentos']:
        for campo in ('documento', 'saldo_anterior', 'abono', 'saldo_restante'):
            if campo not in documento:
                return False, f'Falta el campo {campo} en un documento.'
    return True, 'Datos válidos'


def comprobante_abono(data, en_letras=None):
    """Comprobante que se entrega al cliente al registrar un abono."""
    abono, cliente = data['abono'], data['cliente']
    salida = encabezado_empresa(data.get('datosEmpresa'))
    salida += _titulo('COMPROBANTE DE ABONO')
    if abono.get('cancelado'):
        salida += _titulo('*** CANCELADO ***')
    salida += b'\n'
    salida += _par('FOLIO DE ABONO:', str(abono['folio']))
    salida += _par('FECHA:', abono['fecha'])
    salida += _parrafo(f"CLIENTE: {cliente.get('nombre', '')} (ID {cliente.get('id', '')})")
    if abono.get('cajero'):
        salida += _parrafo(f"ATENDIO: {abono['cajero']}")
    salida += _par('FORMA DE PAGO:', abono['forma_pago'])
    if abono.get('banco'):
        salida += _par('BANCO:', abono['banco'])
    salida += _separador()

    salida += NEGRITA_ON + _renglon('APLICADO A') + NEGRITA_OFF
    for documento in data['documentos']:
        salida += NEGRITA_ON + _parrafo(documento['documento']) + NEGRITA_OFF
        salida += _par('  Saldo anterior:', dinero(documento['saldo_anterior']))
        salida += _par('  Abono:', dinero(documento['abono']))
        salida += _par('  Saldo restante:', dinero(documento['saldo_restante']))
    salida += _separador('=')

    salida += NEGRITA_ON + DOBLE_ALTO_ON + _par('TOTAL ABONADO:', dinero(abono['importe'])) + TAMANO_NORMAL + NEGRITA_OFF
    if en_letras:
        salida += _parrafo(f"({en_letras(float(abono['importe']))})")
    salida += b'\n'
    salida += NEGRITA_ON + _par('SALDO PENDIENTE TOTAL:', dinero(data['saldo_pendiente_cliente'])) + NEGRITA_OFF
    salida += _parrafo('Saldo de todas las cuentas del cliente despues de este abono.')
    if abono.get('concepto'):
        salida += b'\n' + _parrafo(f"CONCEPTO: {abono['concepto']}")

    salida += b'\n\n\n' + CENTRAR + _renglon('_' * 30) + _renglon('RECIBI') + b'\n'
    salida += _renglon('Conserve este comprobante.') + IZQUIERDA
    return salida + AVANCE_Y_CORTE


def validar_estado_cuenta(data):
    if not isinstance(data, dict):
        return False, 'Datos del estado de cuenta vacíos.'
    for campo in ('cliente', 'fecha_corte', 'resumen', 'documentos'):
        if campo not in data:
            return False, f'Falta el campo {campo}.'
    for campo in ('total_documentos', 'pagado', 'pendiente', 'vencido', 'por_vencer'):
        if campo not in data['resumen']:
            return False, f'Falta el campo resumen.{campo}.'
    for documento in data['documentos']:
        for campo in ('documento', 'fecha', 'total', 'pagado', 'pendiente'):
            if campo not in documento:
                return False, f'Falta el campo {campo} en un documento.'
    return True, 'Datos válidos'


def estado_cuenta(data):
    """Estado de cuenta compacto: cuánto debe, cuánto ha pagado y de qué."""
    cliente, resumen = data['cliente'], data['resumen']
    salida = encabezado_empresa(data.get('datosEmpresa'))
    salida += _titulo('ESTADO DE CUENTA') + b'\n'
    salida += _parrafo(f"CLIENTE: {cliente.get('nombre', '')} (ID {cliente.get('id', '')})")
    salida += _par('FECHA:', data['fecha_corte'])
    if float(cliente.get('limite_credito') or 0) > 0:
        salida += _par('LIMITE DE CREDITO:', dinero(cliente['limite_credito']))
    salida += _separador()

    salida += _par(f"Documentos pendientes ({len(data['documentos'])}):", dinero(resumen['total_documentos']))
    salida += _par('Ya pagado de esos documentos:', dinero(resumen['pagado']))
    salida += NEGRITA_ON + DOBLE_ALTO_ON + _par('SALDO PENDIENTE:', dinero(resumen['pendiente'])) + TAMANO_NORMAL + NEGRITA_OFF
    salida += _par('  Vencido:', dinero(resumen['vencido']))
    salida += _par('  Por vencer:', dinero(resumen['por_vencer']))
    salida += _separador()

    if data['documentos']:
        salida += NEGRITA_ON + _par('DOCUMENTO (FECHA)', 'VENCIMIENTO')
        salida += _renglon(f"{'TOTAL':>16}{'PAGADO':>16}{'DEBE':>16}") + NEGRITA_OFF
        for documento in data['documentos']:
            vence = documento.get('vencimiento') or 'SIN FECHA'
            estado = f"VENCIDA {vence}" if documento.get('vencido') else f"VENCE {vence}"
            renglon = _par(f"{documento['documento']} ({documento['fecha']})", estado)
            salida += (NEGRITA_ON + renglon + NEGRITA_OFF) if documento.get('vencido') else renglon
            salida += _renglon(
                f"{dinero(documento['total']):>16}{dinero(documento['pagado']):>16}{dinero(documento['pendiente']):>16}"
            )
        salida += _separador()
    else:
        salida += CENTRAR + _renglon('SIN DOCUMENTOS PENDIENTES') + IZQUIERDA + _separador()

    abonos = data.get('ultimos_abonos') or []
    if abonos:
        salida += NEGRITA_ON + _renglon('ULTIMOS ABONOS') + NEGRITA_OFF
        for abono in abonos:
            salida += _par(f"{abono.get('fecha', '')}  {abono.get('forma_pago', '')}", dinero(abono.get('importe', 0)))
        salida += _separador()

    salida += CENTRAR + _parrafo(f"Saldos al {data['fecha_corte']}.") + IZQUIERDA
    return salida + AVANCE_Y_CORTE


def pagare(cliente, acreedor, domicilio, fecha_emision, fecha_vencimiento, monto, monto_letras):
    """Pagaré de la venta a crédito, en renglones completos y sin acentos.

    Sin días de crédito no hay fecha de vencimiento: se deja un espacio para
    escribirla a mano en lugar de imprimir "---".
    """
    vencimiento = fecha_vencimiento or '____/____/________'
    salida = b'\n' + _titulo('PAGARE') + b'\n'
    salida += _parrafo(f"En {domicilio}, a {fecha_emision}.")
    salida += b'\n'
    salida += _parrafo(
        f"Por medio del presente titulo de credito yo, {cliente} (en lo sucesivo referido como "
        f"\"LA PARTE DEUDORA\"), hago constar que debo y pagare de manera incondicional y sin excepcion "
        f"alguna la cantidad de {dinero(monto)} ({monto_letras}) a la orden de {acreedor} (en lo sucesivo "
        f"referido como \"LA PARTE BENEFICIARIA\"), con domicilio ubicado en: {domicilio}."
    )
    salida += b'\n'
    salida += _parrafo(
        f"El pago de la cantidad monetaria total adeudada al amparo del presente pagare debera ser "
        f"efectuado por \"LA PARTE DEUDORA\" a \"LA PARTE BENEFICIARIA\" el dia {vencimiento}."
    )
    salida += b'\n'
    salida += _parrafo(
        f"El pago debera ser realizado en efectivo en el domicilio con la siguiente direccion: {domicilio}."
    )
    salida += b'\n\n\n' + CENTRAR + _renglon('_' * 30) + _renglon('ACEPTO Y ME OBLIGO AL PAGO')
    salida += _parrafo(cliente) + IZQUIERDA
    return salida
