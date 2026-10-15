function roleNormalizationFixture({ shared = false, adminAlias = false } = {}) {
  return { companyA:'company-a', companyB:'company-b', userA:'user-a',
    roles:[
      {id:73,name:'admin',company_id:null,description:null,permissions:[]},
      {id:61,name:'Bodega',company_id:null,description:null,permissions:[{permission_id:11,permission:{code:'products.view'}}]},
      {id:88,name:'Ventas',company_id:'company-b',description:null,permissions:[{permission_id:12,permission:{code:'sales.view'}}]},
      ...(adminAlias ? [{id:67,name:'Admin',company_id:null,description:null,permissions:[]}] : []),
    ], users:[{id:'user-a',role_id:61}],
    memberships:[{user_id:'user-a',company_id:'company-a',role_id:null,status:'ACTIVE'},
      {user_id:'user-a',company_id:'company-b',role_id:shared ? null : 88,status:'BLOCKED'}],
    branches:[{user_id:'user-a',branch_id:'branch-a'}],
  }
}
module.exports={roleNormalizationFixture}
