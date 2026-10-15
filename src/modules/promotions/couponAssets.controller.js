const assets=require('./couponAssets')
const context=req=>({companyId:req.companyId,userId:req.user.id,draftId:req.query.draft_id??req.body?.draft_id,promotionId:req.query.promotion_id??req.body?.promotion_id,branchId:req.branchId||undefined})
exports.upload=async(req,res,next)=>{try{res.status(201).json(await assets.uploadCouponAsset(context(req),req.file))}catch(e){next(e)}}
exports.resolve=async(req,res,next)=>{try{res.json(await assets.resolveCouponAssets(context(req),req.body?.asset_ids))}catch(e){next(e)}}
exports.remove=async(req,res,next)=>{try{await assets.removeDraftCouponAsset(context(req),req.params.assetId);res.sendStatus(204)}catch(e){next(e)}}
