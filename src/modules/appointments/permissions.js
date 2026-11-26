const permissions = [
  ['view', 'Ver agenda propia'], ['view_team', 'Ver agenda del equipo'], ['create', 'Crear reservas y sesiones'],
  ['edit', 'Reprogramar reservas y sesiones'], ['cancel', 'Cancelar reservas y sesiones'],
  ['attend', 'Registrar atención y asistencia'], ['configure', 'Configurar agenda y servicios'],
  ['collect', 'Recibir anticipos y pagos de contrataciones'], ['refund', 'Resolver y devolver anticipos de contrataciones'], ['issue_sale', 'Generar venta de una contratación'],
].map(([suffix, name]) => ({ code: `appointments.${suffix}`, name, description: name }))
permissions.push({ code: 'appointments.override_payment_policy', name: 'Autorizar atención con saldo vencido', description: 'Permite una excepción puntual con motivo; no registra pagos ni modifica saldos' })
module.exports = { permissions }
