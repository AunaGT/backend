const closureReadPermissions = [
  { code: 'cashclosure.view', name: 'Consultar mis arqueos', description: 'Consulta arqueos propios, incluidos los turnos en que participó; no consulta al equipo' },
  { code: 'cashclosure.view_team', name: 'Consultar arqueos del equipo', description: 'Consulta arqueos del equipo dentro de las sucursales autorizadas; no aprueba ni mueve dinero' },
]
const correctionPermissions = [
  { code:'cashclosure.correct', name:'Proponer correcciones de arqueos finalizados', description:'Propone correcciones sin modificar el original; requiere revisión independiente y no mueve dinero' },
]
const permissions = [
  { code: 'cash.registers.view', name: 'Consultar configuración de cajas', description: 'Consulta metadatos y accesos de cajas de la sucursal; no concede saldos ni cierres del equipo' },
  { code: 'cash.registers.manage', name: 'Configurar cajas y accesos', description: 'Gestiona configuración y personas autorizadas; no concede operación de dinero, adopción ni aprobación' },
]
const movementPermissions = [
  { code: 'cash.movements.view_own', name: 'Consultar mis movimientos de efectivo', description: 'Consulta movimientos físicos propios; no concede arqueos de equipo' },
  { code: 'cash.movements.view_team', name: 'Consultar movimientos de efectivo del equipo', description: 'Consulta movimientos físicos de la sucursal seleccionada' },
  { code: 'cash.movements.create_own', name: 'Registrar efectivo en mi turno', description: 'Registra ingresos y retiros físicos en el turno propio; no paga documentos' },
  { code: 'cash.movements.create_team', name: 'Registrar efectivo en turnos del equipo', description: 'Registra movimientos físicos en turnos autorizados de la sucursal, sin conceder ventas ni cobros ajenos' },
  { code: 'cash.movements.correct', name: 'Compensar movimientos de efectivo', description: 'Registra una compensación física nueva sin reescribir el movimiento original' },
]
const custodyPermissions = [
  { code: 'cash.custody.view', name: 'Consultar custodias y traslados', description: 'Consulta custodias, saldos y traslados de efectivo de la sucursal' },
  { code: 'cash.custody.manage', name: 'Configurar custodias', description: 'Crea y desactiva lugares de custodia (caja fuerte, gerencia); no mueve dinero' },
  { code: 'cash.transfers.operate_own', name: 'Entregar efectivo de mi turno', description: 'Envía efectivo desde el turno propio y entrega el turno; no recibe ni aprueba' },
  { code: 'cash.transfers.operate_team', name: 'Entregar efectivo del equipo y custodias', description: 'Envía efectivo desde turnos de la sucursal y desde custodias; no recibe por otros' },
  { code: 'cash.transfers.receive', name: 'Recibir efectivo', description: 'Confirma o rechaza traslados dirigidos a custodias y cajas de la sucursal' },
]
const policyPermissions = [
  { code: 'cash.policies.manage', name: 'Configurar políticas de arqueo', description: 'Define umbrales de diferencia por medio y conteo ciego; no revisa arqueos ni mueve dinero' },
]
const noticePermissions = [
  { code: 'cash.notices.create', name: 'Registrar avisos de pago', description: 'Registra y consulta pagos que el cliente informó; no cobra, no aplica cartera ni confirma' },
  { code: 'cash.digital.confirm', name: 'Confirmar cobros digitales', description: 'Confirma o rechaza avisos con evidencia en una caja virtual; requiere también registrar cobros de cartera' },
]
const settlementPermissions = [
  { code: 'cash.bank_methods.manage', name: 'Proponer configuración de medios bancarios', description: 'Prepara modo (directo o diferido), destino y cuentas de un medio; la entrada en vigor la aprueba el administrador' },
  { code: 'cash.settlements.manage', name: 'Registrar liquidaciones', description: 'Registra depósitos de proveedores y liquidaciones por sucursal, y consulta lo pendiente de liquidar' },
]
const dailyPermissions = [
  { code: 'cash.day.close', name: 'Finalizar el día de caja', description: 'Revisa y finaliza la consolidación diaria de la sucursal; no cuenta, no revisa arqueos ni mueve dinero' },
]
const disputePermissions = [
  {code:'cash.disputes.view',name:'Consultar disputas de cobros',description:'Consulta reclamos y sus evidencias dentro de las sucursales autorizadas; no crea deuda ni mueve dinero'},
  {code:'cash.disputes.manage',name:'Registrar y proponer disputas',description:'Registra reclamos, evidencia y propuestas; no confirma retiros ni aprueba resoluciones'},
  {code:'cash.disputes.movements',name:'Confirmar movimientos del proveedor',description:'Registra retiros y recuperaciones digitales con soporte; no concede cobros ni cargos al cliente'},
  {code:'cash.disputes.resolve',name:'Resolver disputas',description:'Revisa resultados, pérdidas y compensaciones con separación de funciones; no autoriza cargos al cliente por sí solo'},
  {code:'cash.disputes.charge_customer',name:'Autorizar cargos por contracargos',description:'Junto con resolver disputas autoriza recuperar una pérdida del cliente identificado; no concede registrar cobros'},
]
module.exports = { permissions, movementPermissions, custodyPermissions, policyPermissions, noticePermissions, settlementPermissions, dailyPermissions, closureReadPermissions, correctionPermissions, disputePermissions }
