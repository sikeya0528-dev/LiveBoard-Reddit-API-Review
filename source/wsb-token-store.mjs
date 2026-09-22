import fs from 'node:fs/promises';
import path from 'node:path';

const clean=value=>String(value??'').trim();

export class WsbTokenStore{
  constructor({userData='',safeStorage=null,fileName='wsb-oauth.enc'}={}){
    this.userData=path.resolve(userData||'.');this.safeStorage=safeStorage;this.filePath=path.join(this.userData,fileName);
  }
  available(){try{return !!this.safeStorage?.isEncryptionAvailable?.()}catch{return false}}
  async load(){
    if(!this.available())return {ok:false,reason:'secure_storage_unavailable',token:null};
    try{
      const encrypted=await fs.readFile(this.filePath),plain=this.safeStorage.decryptString(encrypted),raw=JSON.parse(plain);
      const token={accessToken:clean(raw.accessToken),refreshToken:clean(raw.refreshToken),tokenType:clean(raw.tokenType||'bearer'),scope:clean(raw.scope||'read'),expiresAt:Number(raw.expiresAt)||0,updatedAt:Number(raw.updatedAt)||0};
      if(!token.refreshToken&&!token.accessToken)return {ok:false,reason:'oauth_token_missing',token:null};
      return {ok:true,reason:'',token};
    }catch(e){
      if(e?.code==='ENOENT')return {ok:false,reason:'oauth_token_missing',token:null};
      return {ok:false,reason:'oauth_token_unreadable',token:null};
    }
  }
  async save(token={}){
    if(!this.available())throw new Error('secure_storage_unavailable');
    const value={accessToken:clean(token.accessToken),refreshToken:clean(token.refreshToken),tokenType:clean(token.tokenType||'bearer'),scope:clean(token.scope||'read'),expiresAt:Number(token.expiresAt)||0,updatedAt:Date.now()};
    if(!value.accessToken||!value.refreshToken)throw new Error('oauth_token_incomplete');
    await fs.mkdir(path.dirname(this.filePath),{recursive:true,mode:0o700});
    const encrypted=this.safeStorage.encryptString(JSON.stringify(value));
    await fs.writeFile(this.filePath,encrypted,{mode:0o600});
    return {...value,accessToken:'',refreshToken:''};
  }
  async clear(){try{await fs.rm(this.filePath,{force:true})}catch{}return true}
}
