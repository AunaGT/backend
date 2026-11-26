## Task 5: Movimientos reales y liquidaciones sin doble efecto

**Files:** `disputes.effects.js`; modificar `settlements.js`, `settlements.controller.js`; tests `cashDisputes.effects.pg.e2e.js`, `cashDisputes.settlements.pg.e2e.js`, actuales `cashSettlements.test.js` y `.pg.e2e.js`.

**Interfaces:** `confirmDisputeEffect(tx,scope,caseId,{kind:'BANK_DEBIT'|'PROVIDER_WITHHOLDING'|'BANK_RECOVERY'|'PROVIDER_RECOVERY',principal,fee,effectiveOn,accountingDate,reference,evidence,...Command})`; `linkLegacyDeduction(tx,scope,caseId,{deductionId,...Command})`; `settlementDisputePlan(tx,scope,input) -> {effects,recoveries,lines,resources}`.

- [ ] RED: retiroQ100 no crea otro cobro/evento del turno; retenciónQ100 sin depósito deja pendingQ0; retenciónQ20 + liquidaciónQ80 produce totalQ100. RecuperaciónQ101 de retiroQ100 rechazada. FeeQ5 no altera principalQ100.
- [ ] Confirmar referencia bancaria/estado manual y origen; separar efecto autónomo de integrado en liquidación mediante vínculo único. En ejecución contable activa, delegar al helper tarea8 antes de commit; durante desarrollo sin ese helper, la rama activa queda bloqueada, nunca aprobada sin asiento.
- [ ] `pendingReceipts`/guardas DB descuentan retenciones autónomas y asignaciones; no restar una deducción integrada dos veces. Nuevo CHARGEBACK requiere caso/efecto y cuenta específica; deducción puede referirse a recibo antiguo mientras el depósito liquida otros. Extender hash/DTO de settlement para recuperaciones positivas y deducciónID; ecuación exacta net = gross − refunds − deductions + recoveries.
- [ ] Adopción histórica: deductionID íntegra/única y principal exacto, validar toda liquidación/asiento vigente. Ya redujo neto: cero débito nuevo; reclass si gasto verificable según tarea8. Si no verificable, diagnóstico bloqueado, sin completar datos. No modificar neto, filas ni asiento histórico.
- [ ] Proteger voidSettlement: sin descendientes puede compensar atómicamente; con disposición/recuperación/cargo exige reversión enlazada en orden inverso, no borrar pagos. Movimientos corregidos son eventos opuestos nuevos con razón/fecha explícitas; una compensación administrativa no cuenta como recuperación bancaria. Débito de recuperación provisional enlaza la recuperación específica y no permite excederla.
- [ ] Ejecutar pruebas nuevas y regresiones de settlement en QA: GREEN, incluido caso ganado pero dinero pendiente, liquidación de otros recibos con retención de un origen viejo y abono de recuperación en otro depósito.

