# Dispute lock map

Required: optional current operating session → customer IDs sorted → origin event IDs sorted → dependent documents/deposit → accounting company → accounting period.

Observed writers:
- receivables/domain/receivables.applyPayment: session → customer → payment/apps. applyAvailableCredit: customer → receipt/apps.
- receivables/engagementPayments: session if needed → customer → commitments/refunds → accounting company.
- returns/application.complete: optional target session → customer → sale/return → settlement; anonymous sale requires source boundary before document.
- cash-closure/settlements.create: when dispute schema/client available, customer/origin locks → event modes → deposit → company (standalone withholding budget shares this order). Integrated dispute links still pending.
- settlements.void: currently settlement → company. Must pre-acquire same resources before settlement.
- accounting/controller.reverseEntry: currently company → protection. Eligible origin needs origin boundary before company, even no case, to exclude concurrent case insertion.
- cashClosurePosting unrelated correction: company → closure; no customer/origin interaction needed.

Re-read identities after locks; changing customer/origin set =>409, do not extend a lock set out of order. New origin IDs not visible until transaction commit cannot already have a dispute. No command takes historical session locks.

2026-11-23 verified continuation:
- completeReturn: operating session (actual refund only) → customer → all original BANK events via prepareSaleRefundMutation → sale/return → real settlement → immutable per-receipt attribution → refreshed holds. Anonymous direct sale origin is included before document locks; its alias-credit-note follow-through remains pending.
- recordReturnAllocations/recordConfirmedReceiptRefund: same caller transaction and customer/origin boundary, source-allocation advisory lock, approved loss funding (if needed), then reservation refresh. They create no money event; existing caller creates one actual payout event.
- Crossed claim/refund on regular credit-sale receipt tested with transaction barriers, both first-winner orders; second transaction rejects with domain409, no duplicate credit/source.

- Returned CREDIT_NOTE aliases: cash_dispute_receipt_origins follows immutable TRANSFER to the original SALE BANK event. prepareSaleRefundMutation follows applied alias receipts too, before sale/return locks; recordReturnAllocations and legacy guards use the same mapping. Refresh recomputes all sibling notes once per origin; retirement roots/children identify payment_id.
