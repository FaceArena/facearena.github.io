/* FACE ARENA — victory-first game audio. No interface click sounds. */
(function(){
  "use strict";
  const STORAGE_KEY="face_arena_audio_v1";
  const DEFAULTS={enabled:true,volume:65};
  let settings={...DEFAULTS},context=null,master=null,unlocked=false;
  const buffers={};
  const lastPlayed=new Map();
  const COOLDOWN={victory:1200,champion:1600,defeat:900,titleLost:1200,countdown:850};
  try{
    const saved=JSON.parse(localStorage.getItem(STORAGE_KEY)||"null");
    if(saved&&typeof saved==="object"){
      settings.enabled=saved.enabled!==false;
      settings.volume=Math.max(0,Math.min(100,Number.isFinite(Number(saved.volume))?Number(saved.volume):DEFAULTS.volume));
    }
  }catch(_){}
  function persist(){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(settings));}catch(_){}}
  function getContext(){
    if(context)return context;
    const Ctx=window.AudioContext||window.webkitAudioContext;
    if(!Ctx)return null;
    try{
      context=new Ctx();
      master=context.createGain();
      master.gain.value=settings.enabled?settings.volume/100:0;
      master.connect(context.destination);
      return context;
    }catch(_){return null}
  }
  function unlock(){
    const ctx=getContext();
    if(!ctx)return Promise.resolve(false);
    if(ctx.state==="running"){unlocked=true;return Promise.resolve(true)}
    try{
      const resumed=ctx.resume();
      return Promise.resolve(resumed).then(()=>{unlocked=ctx.state==="running";return unlocked}).catch(()=>false);
    }catch(_){return Promise.resolve(false)}
  }
  function setEnabled(value){
    settings.enabled=!!value;
    const ctx=getContext();
    if(master&&ctx)master.gain.setTargetAtTime(settings.enabled?settings.volume/100:0,ctx.currentTime,.025);
    persist();
    // Call resume synchronously from the actual settings-button gesture.
    return settings.enabled?unlock():Promise.resolve(true);
  }
  function setVolume(value){
    settings.volume=Math.max(0,Math.min(100,Number(value)||0));
    if(master&&context)master.gain.setTargetAtTime(settings.enabled?settings.volume/100:0,context.currentTime,.04);
    persist();
  }

  // Render a complete one-shot into an AudioBuffer: impact, airy rise, warm harmonic body and long tail.
  // This avoids the short oscillator beeps used by the previous interface-sound prototype.
  function renderBuffer(kind){
    const ctx=getContext();if(!ctx)return null;
    if(buffers[kind])return buffers[kind];
    const rate=ctx.sampleRate,duration=kind==="defeat"||kind==="titleLost"?2.05:3.25;
    const length=Math.ceil(rate*duration),buffer=ctx.createBuffer(1,length,rate),data=buffer.getChannelData(0);
    const champion=kind==="champion",defeat=kind==="defeat"||kind==="titleLost";
    let seed=kind==="champion"?731:kind==="victory"?419:kind==="titleLost"?283:157;
    const rand=()=>{seed=(seed*16807)%2147483647;return seed/2147483647*2-1};
    const notes=defeat?[{f:293.66,t:.12,d:.72,a:.16},{f:220,t:.68,d:.92,a:.13},{f:164.81,t:1.24,d:.62,a:.10}]:
      champion?[{f:392,t:.20,d:1.65,a:.12},{f:493.88,t:.43,d:1.72,a:.12},{f:587.33,t:.68,d:1.78,a:.13},{f:783.99,t:.95,d:1.95,a:.12},{f:987.77,t:1.22,d:1.85,a:.085}]:
      [{f:329.63,t:.20,d:1.45,a:.11},{f:392,t:.43,d:1.52,a:.12},{f:493.88,t:.68,d:1.62,a:.12},{f:659.25,t:.94,d:1.72,a:.105},{f:783.99,t:1.18,d:1.72,a:.075}];
    for(let i=0;i<length;i++){
      const t=i/rate;
      let sample=0;
      // Deep, soft cinematic hit with a falling sub-frequency tail.
      if(!defeat){
        const hitEnv=Math.exp(-t*7.5);
        const hitFreq=92-34*Math.min(1,t/.42);
        sample+=Math.sin(2*Math.PI*hitFreq*t)*hitEnv*(champion?.34:.25);
      }else{
        sample+=Math.sin(2*Math.PI*(72-28*Math.min(1,t/.9))*t)*Math.exp(-t*3.8)*.17;
      }
      // Airy noise swell; deliberately soft, not a sharp click.
      const swell=Math.max(0,Math.min(1,t/.42))*Math.exp(-Math.pow((t-(defeat?.30:.62))/(defeat?.30:.46),2));
      const noise=rand();
      sample+=noise*swell*(defeat?.018:.026);
      // Warm, layered chord tones with a slow attack and natural decay.
      for(const n of notes){
        const local=t-n.t;if(local<0||local>n.d)continue;
        const attack=Math.min(1,local/.16);
        const decay=Math.pow(Math.max(0,1-local/n.d),.72);
        const env=attack*decay*n.a;
        const fundamental=Math.sin(2*Math.PI*n.f*local);
        const second=Math.sin(2*Math.PI*n.f*2.002*local)*.27;
        const third=Math.sin(2*Math.PI*n.f*3.01*local)*.09;
        const slowMotion=1+.0025*Math.sin(2*Math.PI*.8*local);
        sample+=(fundamental+second+third)*env*slowMotion;
      }
      // A restrained high shimmer on the winning flourish.
      if(!defeat&&t>.9){
        const shimmerEnv=Math.exp(-(t-1.0)*1.35);
        sample+=Math.sin(2*Math.PI*(champion?1568:1318.5)*t)*shimmerEnv*.018;
      }
      data[i]=Math.tanh(sample*1.55)*.88;
    }
    buffers[kind]=buffer;return buffer;
  }

  // A short, restrained timer tick. This is a game countdown cue, not a UI click.
  function playCountdownTick(force){
    if(!force&&(!settings.enabled||settings.volume===0))return false;
    const now=Date.now();
    if(!force&&now-(lastPlayed.get("countdown")||0)<COOLDOWN.countdown)return false;
    const ctx=getContext();if(!ctx||ctx.state!=="running")return false;
    try{
      const osc=ctx.createOscillator(),gain=ctx.createGain();
      const start=ctx.currentTime;
      osc.type="sine";
      osc.frequency.setValueAtTime(880,start);
      osc.frequency.exponentialRampToValueAtTime(660,start+.11);
      gain.gain.setValueAtTime(0.0001,start);
      gain.gain.exponentialRampToValueAtTime(.12*(settings.volume/100),start+.012);
      gain.gain.exponentialRampToValueAtTime(0.0001,start+.14);
      osc.connect(gain);gain.connect(master);
      osc.start(start);osc.stop(start+.15);
      lastPlayed.set("countdown",now);return true;
    }catch(_){return false}
  }

  function playNow(name,force){
    if(!force&&(!settings.enabled||settings.volume===0))return false;
    if(name==="countdown")return playCountdownTick(force);
    if(!["victory","champion","defeat","titleLost"].includes(name))return false;
    const now=Date.now();
    if(!force&&now-(lastPlayed.get(name)||0)<(COOLDOWN[name]||900))return false;
    const ctx=getContext();if(!ctx||ctx.state!=="running")return false;
    const buffer=renderBuffer(name);if(!buffer)return false;
    try{
      const source=ctx.createBufferSource(),gain=ctx.createGain();
      source.buffer=buffer;gain.gain.value=name==="champion"?1.0:name==="victory"?.92:.78;
      source.connect(gain);gain.connect(master);source.start();
      lastPlayed.set(name,now);return true;
    }catch(_){return false}
  }
  function play(name,force){
    const ctx=getContext();if(!ctx)return false;
    if(ctx.state==="running")return playNow(name,force);
    // iOS Safari may suspend Web Audio after the app is backgrounded.
    // Try to resume rather than silently dropping later game effects.
    unlock().then(ok=>{if(ok)playNow(name,force);});
    return false;
  }
  function preview(){
    // Preview is an explicit user action: allow it even when game sounds are muted.
    // Queue the buffer source before awaiting resume; this is more reliable on iOS Safari,
    // where audio started only after an async continuation can be rejected by gesture policy.
    if(settings.volume===0)return Promise.resolve(false);
    const ctx=getContext();
    if(!ctx||!master)return Promise.resolve(false);
    const buffer=renderBuffer("victory");
    if(!buffer)return Promise.resolve(false);
    try{
      const source=ctx.createBufferSource();
      source.buffer=buffer;
      const previewGain=ctx.createGain();
      previewGain.gain.value=.92;
      source.connect(previewGain);
      previewGain.connect(master);
      master.gain.setTargetAtTime(settings.volume/100,ctx.currentTime,.015);
      const resumed=ctx.state==="running"?Promise.resolve(true):ctx.resume();
      source.start(0);
      source.onended=()=>{
        if(context&&master)master.gain.setTargetAtTime(settings.enabled?settings.volume/100:0,context.currentTime,.08);
      };
      return Promise.resolve(resumed).then(()=>{
        unlocked=ctx.state==="running";
        if(!unlocked)master.gain.setTargetAtTime(settings.enabled?settings.volume/100:0,ctx.currentTime,.05);
        return unlocked;
      }).catch(()=>{
        if(master&&context)master.gain.setTargetAtTime(settings.enabled?settings.volume/100:0,context.currentTime,.05);
        return false;
      });
    }catch(_){
      if(master&&context)master.gain.setTargetAtTime(settings.enabled?settings.volume/100:0,context.currentTime,.05);
      return Promise.resolve(false);
    }
  }
  // Repeated gestures allow recovery after iOS suspends the audio context.
  document.addEventListener("pointerdown",unlock,{passive:true});
  document.addEventListener("touchend",unlock,{passive:true});
  document.addEventListener("keydown",unlock);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)unlock();});
  window.FaceArenaAudio={play,preview,unlock,getSettings(){return {...settings}},setEnabled,setVolume};
})();