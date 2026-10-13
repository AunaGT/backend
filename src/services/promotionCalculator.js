/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 * 
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 * 
 * For licensing inquiries: GitHub @dpatzan2
 */

/**
 * Promotion Calculator Service
 * Handles all discount calculation logic for different promotion types
 */

const PROMOTION_TYPES = {
    PERCENTAGE: 'PERCENTAGE',
    FIXED_AMOUNT: 'FIXED_AMOUNT',
    BUY_X_GET_Y: 'BUY_X_GET_Y',
    COMBO_DISCOUNT: 'COMBO_DISCOUNT',
    FREE_GIFT: 'FREE_GIFT',
    MIN_QTY_DISCOUNT: 'MIN_QTY_DISCOUNT'
}
const {Prisma}=require('@prisma/client')

/** Línea del carrito coincide con alcance por producto/categoría (promo no “aplica a todos”) */
function itemMatchesRestrictedScope(promotion, item) {
    const applicableProductIds = new Set(
        (promotion.applicable_products || []).map(pp => pp.product_id)
    )
    const applicableCategoryIds = new Set(
        (promotion.applicable_categories || []).map(pc => Number(pc.category_id))
    )
    const cid = item.category_id != null && item.category_id !== ''
        ? Number(item.category_id)
        : null
    return (
        applicableProductIds.has(item.product_id) ||
        (cid != null && !Number.isNaN(cid) && applicableCategoryIds.has(cid))
    )
}

/**
 * Subtotal sobre el que exige min_purchase cuando el tipo tiene alcance restringido.
 * null → usar total del carrito.
 */
function eligibleSubtotalForMinPurchase(promotion, cartItems, typeName) {
    const scopedTypes = [
        PROMOTION_TYPES.PERCENTAGE,
        PROMOTION_TYPES.BUY_X_GET_Y,
        PROMOTION_TYPES.MIN_QTY_DISCOUNT
    ]
    if (!scopedTypes.includes(typeName)) return null
    if (promotion.applies_to_all) return null
    let sum = 0
    for (const item of cartItems || []) {
        if (itemMatchesRestrictedScope(promotion, item)) {
            sum += Number(item.price) * Number(item.qty || 0)
        }
    }
    return Math.round(sum * 100) / 100
}

/**
 * Calculate percentage discount
 * @param {Object} promotion - The promotion object
 * @param {Array} cartItems - Cart items with { product_id, price, qty }
 * @returns {Object} { discount, details }
 */
function calculatePercentageDiscount(promotion, cartItems) {
    const percentage = Number(promotion.discount_percentage) / 100
    let applicableTotal = 0
    const itemsAffected = []

    if (promotion.applies_to_all) {
        // Apply to all items
        applicableTotal = cartItems.reduce((sum, item) => sum + (Number(item.price) * item.qty), 0)
        itemsAffected.push(...cartItems.map(item => item.product_id))
    } else {
        for (const item of cartItems) {
            if (itemMatchesRestrictedScope(promotion, item)) {
                applicableTotal += Number(item.price) * item.qty
                itemsAffected.push(item.product_id)
            }
        }
    }

    const eligibleItems=promotion.applies_to_all ? cartItems : cartItems.filter(item=>itemMatchesRestrictedScope(promotion,item))
    const exactTotal=eligibleItems.reduce((sum,item)=>sum.add(new Prisma.Decimal(String(item.price)).mul(String(item.qty))),new Prisma.Decimal(0))
    const discount = exactTotal.mul(String(promotion.discount_percentage)).div(100).toDecimalPlaces(2,Prisma.Decimal.ROUND_HALF_UP).toNumber()

    return {
        discount,
        details: {
            type: PROMOTION_TYPES.PERCENTAGE,
            percentage: Number(promotion.discount_percentage),
            itemsAffected,
            applicableTotal
        }
    }
}

/**
 * Calculate fixed amount discount
 */
function calculateFixedDiscount(promotion, cartItems) {
    const cartTotal = cartItems.reduce((sum,item)=>sum.add(new Prisma.Decimal(String(item.price)).mul(String(item.qty))),new Prisma.Decimal(0))
    const discountValue = Number(promotion.discount_value)

    // Don't discount more than the cart total
    const discount = Prisma.Decimal.min(String(discountValue),cartTotal).toDecimalPlaces(2,Prisma.Decimal.ROUND_HALF_UP).toNumber()

    return {
        discount: Math.round(discount * 100) / 100,
        details: {
            type: PROMOTION_TYPES.FIXED_AMOUNT,
            fixedAmount: discountValue
        }
    }
}

/**
 * Calculate Buy X Get Y discount (e.g., 2x1, 3x2)
 */
function calculateBuyXGetY(promotion, cartItems) {
    const buyQty = promotion.buy_quantity || 2
    const getQty = promotion.get_quantity || 1
    let totalDiscount = 0
    const itemsAffected = []

    for (const item of cartItems) {
        const isApplicable = promotion.applies_to_all || itemMatchesRestrictedScope(promotion, item)

        if (isApplicable && item.qty >= buyQty) {
            // Calculate how many "sets" of buyQty the customer is getting
            const sets = Math.floor(item.qty / buyQty)
            // For each set, they get 'getQty' free items
            const freeItems = sets * getQty
            const itemDiscount = freeItems * Number(item.price)

            totalDiscount += itemDiscount
            itemsAffected.push({
                product_id: item.product_id,
                freeQty: freeItems,
                itemDiscount
            })
        }
    }

    return {
        discount: Math.round(totalDiscount * 100) / 100,
        details: {
            type: PROMOTION_TYPES.BUY_X_GET_Y,
            buyQty,
            getQty,
            itemsAffected
        }
    }
}

/**
 * Calculate combo discount (buy product A, get discount on product B)
 */
function calculateComboDiscount(promotion, cartItems) {
    const triggerProductId = promotion.trigger_product_id
    const targetProductId = promotion.target_product_id
    const discountPercentage = Number(promotion.discount_percentage || 0) / 100
    const discountValue = Number(promotion.discount_value || 0)

    // Check if trigger product is in cart
    const triggerItem = cartItems.find(item => item.product_id === triggerProductId)
    if (!triggerItem) {
        return {
            discount: 0,
            details: {
                type: PROMOTION_TYPES.COMBO_DISCOUNT,
                reason: 'Producto activador no encontrado en el carrito',
                triggerProductId
            }
        }
    }

    // Check if target product is in cart
    const targetItem = cartItems.find(item => item.product_id === targetProductId)
    if (!targetItem) {
        return {
            discount: 0,
            details: {
                type: PROMOTION_TYPES.COMBO_DISCOUNT,
                reason: 'Producto objetivo no encontrado en el carrito',
                targetProductId
            }
        }
    }

    // Calculate discount on target product
    const targetPrice = Number(targetItem.price)
    let discount = 0

    if (discountPercentage > 0) {
        discount = targetPrice * discountPercentage
    } else if (discountValue > 0) {
        discount = Math.min(discountValue, targetPrice)
    }

    return {
        discount: Math.round(discount * 100) / 100,
        details: {
            type: PROMOTION_TYPES.COMBO_DISCOUNT,
            triggerProductId,
            targetProductId,
            discountApplied: discount
        }
    }
}

/**
 * Calculate free gift (buy product A, get product B free)
 */
function calculateFreeGift(promotion, cartItems) {
    const triggerProductId = promotion.trigger_product_id
    const targetProductId = promotion.target_product_id

    // Check if trigger product is in cart
    const triggerItem = cartItems.find(item => item.product_id === triggerProductId)
    if (!triggerItem) {
        return {
            discount: 0,
            freeGift: null,
            details: {
                type: PROMOTION_TYPES.FREE_GIFT,
                reason: 'Producto activador no encontrado en el carrito'
            }
        }
    }

    // Check if target product is in cart  
    const targetItem = cartItems.find(item => item.product_id === targetProductId)
    if (!targetItem) {
        return {
            discount: 0,
            freeGift: {
                product_id: targetProductId,
                mustAddToCart: true
            },
            details: {
                type: PROMOTION_TYPES.FREE_GIFT,
                reason: 'El regalo debe agregarse al carrito',
                targetProductId
            }
        }
    }

    // Target product is free (discount = full price of 1 unit)
    const discount = Number(targetItem.price)

    return {
        discount: Math.round(discount * 100) / 100,
        freeGift: {
            product_id: targetProductId,
            qty: 1
        },
        details: {
            type: PROMOTION_TYPES.FREE_GIFT,
            triggerProductId,
            targetProductId,
            giftValue: discount
        }
    }
}

/**
 * Calculate minimum quantity discount
 */
function calculateMinQtyDiscount(promotion, cartItems) {
    const minQty = promotion.min_quantity || 3
    const discountPercentage = Number(promotion.discount_percentage) / 100
    let totalDiscount = 0
    const itemsAffected = []

    for (const item of cartItems) {
        const isApplicable = promotion.applies_to_all || itemMatchesRestrictedScope(promotion, item)

        if (isApplicable && item.qty >= minQty) {
            const itemTotal = Number(item.price) * item.qty
            const itemDiscount = itemTotal * discountPercentage
            totalDiscount += itemDiscount
            itemsAffected.push({
                product_id: item.product_id,
                qty: item.qty,
                discount: itemDiscount
            })
        }
    }

    return {
        discount: Math.round(totalDiscount * 100) / 100,
        details: {
            type: PROMOTION_TYPES.MIN_QTY_DISCOUNT,
            minQty,
            percentage: Number(promotion.discount_percentage),
            itemsAffected
        }
    }
}

/**
 * Main function to apply a promotion to cart items
 * @param {Object} promotion - Full promotion object with type relation
 * @param {Array} cartItems - Cart items array
 * @returns {Object} { discount, details, freeGift? }
 */
function applyPromotion(promotion, cartItems) {
    const typeName = promotion.type?.name || ''
    if (![PROMOTION_TYPES.PERCENTAGE,PROMOTION_TYPES.FIXED_AMOUNT].includes(typeName)) cartItems=(cartItems || []).filter(item=>(item.item_kind ?? item.kind)!=='SERVICE')
    const cartTotal = (cartItems || []).reduce(
        (sum, item) => sum + (Number(item.price) * Number(item.qty || 0)),
        0
    )

    // Compra mínima: en %, 2×1 y cantidad mínima con alcance restringido → subtotal elegible; si no, total carrito
    if (promotion.min_purchase_amount != null && promotion.min_purchase_amount !== '') {
        const required = Number(promotion.min_purchase_amount)
        if (!isNaN(required) && required > 0) {
            const eligible = eligibleSubtotalForMinPurchase(promotion, cartItems, typeName)
            const basis = eligible !== null ? eligible : cartTotal
            if (basis < required) {
                return {
                    discount: 0,
                    details: {
                        type: typeName || 'UNKNOWN',
                        reason: 'Compra mínima no alcanzada',
                        required,
                        current: Math.round(basis * 100) / 100,
                        basisType: eligible !== null ? 'eligible_subtotal' : 'cart_total'
                    }
                }
            }
        }
    }

    switch (typeName) {
        case PROMOTION_TYPES.PERCENTAGE:
            return calculatePercentageDiscount(promotion, cartItems)
        case PROMOTION_TYPES.FIXED_AMOUNT:
            return calculateFixedDiscount(promotion, cartItems)
        case PROMOTION_TYPES.BUY_X_GET_Y:
            return calculateBuyXGetY(promotion, cartItems)
        case PROMOTION_TYPES.COMBO_DISCOUNT:
            return calculateComboDiscount(promotion, cartItems)
        case PROMOTION_TYPES.FREE_GIFT:
            return calculateFreeGift(promotion, cartItems)
        case PROMOTION_TYPES.MIN_QTY_DISCOUNT:
            return calculateMinQtyDiscount(promotion, cartItems)
        default:
            return {
                discount: 0,
                details: {
                    type: 'UNKNOWN',
                    reason: `Tipo de promoción no reconocido: ${typeName}`
                }
            }
    }
}

/**
 * Apply multiple promotions to cart items
 * @param {Array} promotions - Array of promotion objects
 * @param {Array} cartItems - Cart items array
 * @returns {Object} { totalDiscount, appliedPromotions[], freeGifts[] }
 */
function applyMultiplePromotions(promotions, cartItems) {
    let totalDiscount = 0
    const appliedPromotions = []
    const freeGifts = []

    for (const promotion of promotions) {
        const result = applyPromotion(promotion, cartItems)

        if (result.discount > 0) {
            totalDiscount += result.discount
            appliedPromotions.push({
                promotionId: promotion.id,
                usedCodeId: promotion.usedCodeId ?? null,
                usedCode: promotion.usedCode ?? null,
                name: promotion.name,
                discount: result.discount,
                details: result.details
            })
        }

        if (result.freeGift) {
            freeGifts.push(result.freeGift)
        }
    }

    return {
        totalDiscount: Math.round(totalDiscount * 100) / 100,
        appliedPromotions,
        freeGifts
    }
}

module.exports = {
    PROMOTION_TYPES,
    applyPromotion,
    applyMultiplePromotions,
    calculatePercentageDiscount,
    calculateFixedDiscount,
    calculateBuyXGetY,
    calculateComboDiscount,
    calculateFreeGift,
    calculateMinQtyDiscount
}
