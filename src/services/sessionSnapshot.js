// One statement gives each request a fresh, consistent authorization snapshot.
async function readSessionSnapshot(db,payload,{includeBranches=false,passwordChangeAction}){
 const sid=payload.sid||null
 const [row]=await db.$queryRaw`
  SELECT u.*,
   COALESCE(members.items,'[]'::jsonb) AS user_companies,
   CASE WHEN ${includeBranches}::boolean THEN COALESCE(branches.items,'[]'::jsonb) ELSE NULL END AS user_branches,
   COALESCE(roles.items,'[]'::jsonb) AS _session_roles,
   (${sid}::uuid IS NULL OR EXISTS(SELECT 1 FROM refresh_tokens t WHERE t.user_id=u.id
    AND t.session_id=${sid}::uuid AND t.revoked_at IS NULL AND t.expires_at>CURRENT_TIMESTAMP)) AS _session_valid,
   (u.password_changed_at IS NULL AND EXISTS(SELECT 1 FROM user_access_events e
    WHERE e.user_id=u.id AND e.action=${passwordChangeAction})) AS _password_required
  FROM users u
  LEFT JOIN LATERAL (
   SELECT jsonb_agg(to_jsonb(m)||jsonb_build_object('company',jsonb_build_object('active',c.active),
    'created_at',m.created_at AT TIME ZONE 'UTC','last_access_at',m.last_access_at AT TIME ZONE 'UTC')
    ORDER BY m.created_at,m.company_id) AS items
   FROM user_companies m JOIN companies c ON c.id=m.company_id WHERE m.user_id=u.id
  ) members ON TRUE
  LEFT JOIN LATERAL (
   SELECT jsonb_agg(jsonb_build_object('branch',jsonb_build_object('id',b.id,'company_id',b.company_id,
    'active',b.active,'is_default',b.is_default)) ORDER BY ub.created_at,ub.branch_id) AS items
   FROM user_branches ub JOIN branches b ON b.id=ub.branch_id
   WHERE ub.user_id=u.id AND ${includeBranches}::boolean
  ) branches ON TRUE
  LEFT JOIN LATERAL (
   SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('permissions',COALESCE((
    SELECT jsonb_agg(to_jsonb(rp)||jsonb_build_object('permission',to_jsonb(p)) ORDER BY p.id)
    FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=r.id
   ),'[]'::jsonb)) ORDER BY r.id) AS items
   FROM roles r WHERE r.id=u.role_id OR EXISTS(
    SELECT 1 FROM user_companies m WHERE m.user_id=u.id AND m.role_id=r.id)
  ) roles ON TRUE
  WHERE u.id=${payload.sub}::uuid`
 if(!row)return null
 const {_session_roles:roles,_session_valid:sessionValid,_password_required:passwordRequired,...user}=row
 if(!includeBranches)delete user.user_branches
 return{user,roles,sessionValid,passwordRequired}
}
module.exports={readSessionSnapshot}
