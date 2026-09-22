const OAUTH_ORIGIN='https://oauth.reddit.com';
const AUTHORIZE_ORIGIN='https://www.reddit.com';
const SUBREDDIT='wallstreetbets';
const READ_SCOPE='read';

const cleanString=(value,name,{max=512}={})=>{
  const s=String(value??'').trim();
  if(!s||s.length>max)throw new Error(`${name}_invalid`);
  return s;
};
const requireHttpsOrLoopback=url=>{
  const u=new URL(url);
  const loopback=['127.0.0.1','localhost','[::1]'].includes(u.hostname);
  if(u.protocol!=='https:'&&!loopback)throw new Error('redirect_uri_insecure');
  if(u.username||u.password)throw new Error('redirect_uri_credentials_rejected');
  return u;
};

export const REDDIT_STAGE07_POLICY=Object.freeze({
  requiresExplicitApiApproval:true,
  requiresOAuth:true,
  anonymousJsonFallback:false,
  proxyFallback:false,
  subreddit:SUBREDDIT,
  scope:READ_SCOPE,
  userAgentRequired:true
});

export const redditEndpointPlan=()=>Object.freeze({
  origin:OAUTH_ORIGIN,
  scope:READ_SCOPE,
  subreddit:SUBREDDIT,
  candidates:Object.freeze({
    hot:`${OAUTH_ORIGIN}/r/${SUBREDDIT}/hot`,
    new:`${OAUTH_ORIGIN}/r/${SUBREDDIT}/new`,
    latestComments:`${OAUTH_ORIGIN}/r/${SUBREDDIT}/comments`,
    threadCommentsTemplate:`${OAUTH_ORIGIN}/comments/{id}`
  })
});

export function assertApprovedRedditConfig(config={}){
  if(config.approvalGranted!==true)throw new Error('reddit_api_approval_required');
  const clientId=cleanString(config.clientId,'client_id',{max:128});
  const redirectUri=requireHttpsOrLoopback(cleanString(config.redirectUri,'redirect_uri',{max:1024})).toString();
  const userAgent=cleanString(config.userAgent,'user_agent',{max:256});
  if(!/liveboard/i.test(userAgent))throw new Error('user_agent_must_identify_liveboard');
  return Object.freeze({clientId,redirectUri,userAgent,scope:READ_SCOPE});
}

export function createInstalledClientAuthorization(config,{state}={}){
  const approved=assertApprovedRedditConfig(config);
  const oauthState=cleanString(state,'oauth_state',{max:256});
  if(oauthState.length<20)throw new Error('oauth_state_too_short');
  const u=new URL('/api/v1/authorize',AUTHORIZE_ORIGIN);
  u.searchParams.set('client_id',approved.clientId);
  u.searchParams.set('response_type','code');
  u.searchParams.set('state',oauthState);
  u.searchParams.set('redirect_uri',approved.redirectUri);
  u.searchParams.set('duration','permanent');
  u.searchParams.set('scope',approved.scope);
  return Object.freeze({url:u.toString(),state:oauthState,redirectUri:approved.redirectUri,scope:approved.scope});
}

export function validateInstalledClientCallback(callbackUrl,{expectedState,redirectUri}={}){
  const expected=cleanString(expectedState,'expected_state',{max:256});
  const registered=requireHttpsOrLoopback(cleanString(redirectUri,'redirect_uri',{max:1024}));
  const callback=new URL(cleanString(callbackUrl,'callback_url',{max:4096}));
  if(callback.origin!==registered.origin||callback.pathname!==registered.pathname)throw new Error('oauth_callback_redirect_mismatch');
  if(callback.searchParams.get('state')!==expected)throw new Error('oauth_state_mismatch');
  const error=callback.searchParams.get('error');
  if(error)throw new Error(`oauth_denied:${error}`);
  const code=callback.searchParams.get('code');
  if(!code)throw new Error('oauth_code_missing');
  return Object.freeze({code,state:expected});
}

export function buildAuthorizationCodeExchange(config,{code}={}){
  const approved=assertApprovedRedditConfig(config);
  const authorizationCode=cleanString(code,'authorization_code',{max:2048});
  const body=new URLSearchParams({grant_type:'authorization_code',code:authorizationCode,redirect_uri:approved.redirectUri}).toString();
  return Object.freeze({
    url:'https://www.reddit.com/api/v1/access_token',
    method:'POST',
    headers:Object.freeze({'content-type':'application/x-www-form-urlencoded','user-agent':approved.userAgent}),
    basicAuth:Object.freeze({username:approved.clientId,password:''}),
    body
  });
}

export function buildRefreshTokenExchange(config,{refreshToken}={}){
  const approved=assertApprovedRedditConfig(config);
  const token=cleanString(refreshToken,'refresh_token',{max:4096});
  const body=new URLSearchParams({grant_type:'refresh_token',refresh_token:token}).toString();
  return Object.freeze({
    url:'https://www.reddit.com/api/v1/access_token',method:'POST',
    headers:Object.freeze({'content-type':'application/x-www-form-urlencoded','user-agent':approved.userAgent}),
    basicAuth:Object.freeze({username:approved.clientId,password:''}),body
  });
}

export function buildReadRequest(config,{accessToken,path,query={}}={}){
  const approved=assertApprovedRedditConfig(config);
  const token=cleanString(accessToken,'access_token',{max:4096});
  const relative=cleanString(path,'path',{max:1024});
  if(!relative.startsWith('/'))throw new Error('reddit_path_must_be_relative');
  const u=new URL(relative,OAUTH_ORIGIN);
  if(u.origin!==OAUTH_ORIGIN)throw new Error('reddit_origin_rejected');
  for(const [key,value] of Object.entries(query||{})){
    if(value===undefined||value===null)continue;
    u.searchParams.set(String(key),String(value));
  }
  return Object.freeze({url:u.toString(),method:'GET',headers:Object.freeze({authorization:`bearer ${token}`,'user-agent':approved.userAgent})});
}
