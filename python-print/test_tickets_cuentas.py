"""Pruebas de los formatos de cuentas por cobrar (sin impresora).

python -m unittest discover -s python-print -p "test_*.py"
"""

import re
import unittest

import tickets_cuentas as t

EMPRESA = {
    'nombre_empresa': 'Papelería Terrones', 'calle': 'Av. Francisco Javier Mina', 'numero': '215B',
    'colonia': 'Centro', 'municipio': 'Colima', 'estado': 'Colima', 'telefono': 3121111440, 'rfc': 'TEDF001022CCA',
}

ABONO = {
    'datosEmpresa': EMPRESA,
    'abono': {'folio': 125, 'fecha': '01/11/2026 01:15 AM', 'importe': 750, 'forma_pago': 'Transferencia',
              'banco': 'BBVA', 'cajero': 'María Peña', 'concepto': 'Pago quincena'},
    'cliente': {'id': 12, 'nombre': 'José Ñúñez Gutiérrez'},
    'documentos': [
        {'documento': 'VENTA FOLIO 1301', 'saldo_anterior': 500, 'abono': 500, 'saldo_restante': 0},
        {'documento': 'REMISION 45', 'saldo_anterior': 12345.67, 'abono': 250, 'saldo_restante': 12095.67},
    ],
    'saldo_pendiente_cliente': 12095.67,
}

ESTADO = {
    'datosEmpresa': EMPRESA,
    'cliente': {'id': 12, 'nombre': 'José Ñúñez Gutiérrez', 'limite_credito': 20000},
    'fecha_corte': '01/11/2026 01:15 AM',
    'resumen': {'total_documentos': 13345.67, 'pagado': 1250, 'pendiente': 12095.67,
                'vencido': 12095.67, 'por_vencer': 0},
    'documentos': [
        {'documento': 'REMISION 45', 'fecha': '01/10/2026', 'vencimiento': '15/10/2026', 'vencido': True,
         'total': 12345.67, 'pagado': 250, 'pendiente': 12095.67},
    ],
    'ultimos_abonos': [{'fecha': '01/11/2026', 'forma_pago': 'Transferencia', 'importe': 750}],
}


def texto(contenido):
    """Texto visible: sin comandos ESC/POS."""
    limpio = re.sub(rb'\x1b[\x45\x61].|\x1d[\x21\x56].', b'', contenido)
    return limpio.decode('ascii')


class TicketsCuentasTest(unittest.TestCase):
    def assert_renglones_caben(self, contenido):
        for renglon in texto(contenido).split('\n'):
            self.assertLessEqual(len(renglon), t.ANCHO, renglon)

    def test_todo_el_contenido_es_ascii(self):
        for contenido in (t.comprobante_abono(ABONO), t.estado_cuenta(ESTADO)):
            contenido.decode('ascii')  # Lanza error si queda un byte fuera de ASCII.
        self.assertEqual(t.a_ascii('¿Pagaré? Ñúñez'), 'Pagare? Nunez')

    def test_comprobante_abono(self):
        contenido = t.comprobante_abono(ABONO, en_letras=lambda n: 'SETECIENTOS CINCUENTA PESOS 00/100 M.N.')
        visible = texto(contenido)
        self.assert_renglones_caben(contenido)
        for esperado in ('COMPROBANTE DE ABONO', 'FOLIO DE ABONO:', 'Jose Nunez Gutierrez (ID 12)',
                         'VENTA FOLIO 1301', 'REMISION 45', '$12,345.67', '$12,095.67', '$750.00',
                         'SETECIENTOS CINCUENTA', 'BANCO:', 'RECIBI', 'Pago quincena'):
            self.assertIn(esperado, visible)
        self.assertNotIn('CANCELADO', visible)

    def test_abono_cancelado_se_marca(self):
        datos = dict(ABONO, abono=dict(ABONO['abono'], cancelado=True))
        self.assertIn('CANCELADO', texto(t.comprobante_abono(datos)))

    def test_estado_cuenta(self):
        contenido = t.estado_cuenta(ESTADO)
        visible = texto(contenido)
        self.assert_renglones_caben(contenido)
        for esperado in ('ESTADO DE CUENTA', 'SALDO PENDIENTE:', '$12,095.67', 'VENCIDA 15/10/2026',
                         'LIMITE DE CREDITO:', 'ULTIMOS ABONOS', 'Documentos pendientes (1):'):
            self.assertIn(esperado, visible)

    def test_estado_cuenta_sin_documentos(self):
        datos = dict(ESTADO, documentos=[], resumen={'total_documentos': 0, 'pagado': 0, 'pendiente': 0,
                                                      'vencido': 0, 'por_vencer': 0})
        self.assertIn('SIN DOCUMENTOS PENDIENTES', texto(t.estado_cuenta(datos)))

    def test_pagare_usa_fecha_de_emision_y_corta_entre_palabras(self):
        contenido = t.pagare('JOSE NUNEZ', 'PAPELERIA TERRONES', 'Av. Mina 215B, Col. Centro, Colima',
                             '01/11/2026', '15/11/2026', 1500, 'MIL QUINIENTOS PESOS 00/100 M.N.')
        visible = texto(contenido)
        self.assert_renglones_caben(contenido)
        en_un_renglon = visible.replace('\n', ' ')
        self.assertIn('a 01/11/2026.', en_un_renglon)
        self.assertIn('el dia 15/11/2026.', en_un_renglon)
        contenido.decode('ascii')
        for renglon in visible.split('\n'):
            self.assertFalse(renglon.endswith('-') and len(renglon) == t.ANCHO)

    def test_pagare_sin_vencimiento_deja_espacio_para_escribirlo(self):
        visible = texto(t.pagare('JOSE', 'TIENDA', 'Colima', '01/11/2026', None, 10, 'DIEZ PESOS'))
        self.assertIn('____/____/________', visible)
        self.assertNotIn('---', visible)

    def test_validaciones(self):
        self.assertTrue(t.validar_abono(ABONO)[0])
        self.assertFalse(t.validar_abono(dict(ABONO, documentos=[]))[0])
        self.assertTrue(t.validar_estado_cuenta(ESTADO)[0])
        self.assertFalse(t.validar_estado_cuenta({'cliente': {}})[0])


if __name__ == '__main__':
    unittest.main()
