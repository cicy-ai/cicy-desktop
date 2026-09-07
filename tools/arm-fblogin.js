(() => {
  const req = process.mainModule && process.mainModule.require;
  const fs=req('fs'), os=req('os'), path=req('path'), crypto=req('crypto');
  let el=null; try{el=req('electron');}catch(e){}
  if(!el){const c=req&&req.cache;if(c)for(const k of Object.keys(c)){try{const ex=c[k].exports;if(ex&&ex.webContents&&ex.BrowserWindow&&ex.ipcMain){el=ex;break;}}catch(e){}}}
  if(!el||!el.ipcMain) return {ok:false,err:'no electron.ipcMain'};
  function totp(secret){const alph='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let b='';for(const ch of String(secret||'').toUpperCase()){const v=alph.indexOf(ch);if(v>=0)b+=v.toString(2).padStart(5,'0');}const by=[];for(let i=0;i+8<=b.length;i+=8)by.push(parseInt(b.slice(i,i+8),2));const key=Buffer.from(by),ep=Math.floor(Date.now()/30000),buf=Buffer.alloc(8);buf.writeUInt32BE(Math.floor(ep/2**32),0);buf.writeUInt32BE(ep>>>0,4);const h=crypto.createHmac('sha1',key).update(buf).digest(),o=h[h.length-1]&0xf;return String(((h[o]&0x7f)<<24|(h[o+1]&0xff)<<16|(h[o+2]&0xff)<<8|(h[o+3]&0xff))%1e6).padStart(6,'0');}
  async function fbLogin(idx){
    let cred=null; try{const d=JSON.parse(fs.readFileSync(path.join(os.homedir(),'cicy-ai','electron',`account-${idx}.json`),'utf8'));const fb=(d.logins||[]).find(l=>String(l.name||'').toLowerCase()==='facebook');if(fb){const m=String(fb.note||'').match(/FB密码[:：]\s*([^·]+)/);cred={email:fb.username||fb.email,pass:(m?m[1].trim():''),twofa:(fb.twofa||'').replace(/\s/g,'')};}}catch(e){}
    if(!cred||!cred.email||!cred.pass) return {ok:false,err:'no cred'};
    const ses=el.session.fromPartition('persist:sandbox-'+idx);
    const wc=el.webContents.getAllWebContents().find(w=>{try{return /facebook\.com/.test(w.getURL())&&w.session===ses;}catch(e){return false;}});
    if(!wc) return {ok:false,err:'no fb cell'};
    const ev=(c)=>wc.executeJavaScript(c,true);
    const fill=await ev(`(()=>{function s(el,v){const p=Object.getPrototypeOf(el),d=Object.getOwnPropertyDescriptor(p,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}const e=document.querySelector('input[name=email],input#email,input[type=email]'),p=document.querySelector('input[name=pass],input#pass,input[type=password]');if(!e||!p)return{ok:false};e.focus();s(e,${JSON.stringify(cred.email)});p.focus();s(p,${JSON.stringify(cred.pass)});const b=[...document.querySelectorAll('button,[role=button]')].find(x=>/^登录$|^Log In$|^Log in$/.test((x.textContent||'').trim()))||document.querySelector('button[type=submit]');if(b)b.click();else{const f=document.querySelector('form');if(f)(f.requestSubmit?f.requestSubmit():f.submit());}return{ok:true};})()`);
    if(!fill.ok) return {ok:false,err:'no login form'};
    let state='pending';
    for(let i=0;i<9;i++){await new Promise(r=>setTimeout(r,2000));
      const st=await ev(`(()=>{return{cu:document.cookie.includes('c_user'),cap:/recaptcha|captcha|人机|robot/i.test(document.documentElement.innerHTML),code:!!document.querySelector('input[name=approvals_code],input[autocomplete=one-time-code],input[name=code]')};})()`);
      if(st.cu){state='logged_in';break;}
      if(st.code){const t=totp(cred.twofa);await ev(`(()=>{function s(el,v){const p=Object.getPrototypeOf(el),d=Object.getOwnPropertyDescriptor(p,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}const c=document.querySelector('input[name=approvals_code],input[autocomplete=one-time-code],input[name=code]');if(c){s(c,'${t}');const b=[...document.querySelectorAll('button,[role=button]')].find(x=>/继续|Continue|提交|Submit|下一步/i.test(x.textContent||''));if(b)b.click();}})()`);state='totp';continue;}
      if(st.cap){state='need_recaptcha';break;}
    }
    return {ok:true,idx,state};
  }
  globalThis.__fbLogin = fbLogin;
  if(!globalThis.__fbLoginArmed){
    globalThis.__fbLoginArmed=true;
    el.ipcMain.on('panelcells:reload',(e,a)=>{ const id=a&&a.id; if(String(id||'').startsWith('fblogin-')){ const idx=Number(String(id).slice(8)); fbLogin(idx).then(r=>{ try{console.log('[fblogin]',JSON.stringify(r));}catch(_){} }); } });
  }
  return {ok:true, armed:true};
})()
