# Fixtures fiscales

Usar solo datos sintéticos en pruebas unitarias y PostgreSQL efímero local. No colocar credenciales, respuestas XML de clientes, PFX ni volcados de las bases.

Los casos de cifrado utilizan claves de 32 bytes repetidos exclusivamente en memoria de tests. No son configuración del servidor ni claves recomendadas para usar realmente.

Ninguna prueba de esta entrega contacta a Infile o a los servidores Odoo. No se permite que un flag de entorno transforme una prueba offline en una emisión real.
