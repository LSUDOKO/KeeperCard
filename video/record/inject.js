(()=>{if(window.__kc)return 'already';window.__kc=1;
const c=document.createElement('div');c.id='__cur';c.style.cssText='position:fixed;left:0;top:0;width:28px;height:36px;z-index:2147483647;pointer-events:none;transition:transform .38s cubic-bezier(.2,.7,.2,1),scale .12s;transform:translate(-100px,-100px);filter:drop-shadow(0 2px 5px rgba(0,0,0,.4))';
c.innerHTML='<svg width="28" height="36" viewBox="0 0 28 36"><path d="M4 2 L4 28 L10.5 22 L15 33 L20 31 L15.5 20.5 L24 20.5 Z" fill="#111" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>';
document.body.appendChild(c);
document.addEventListener('mousemove',e=>{c.style.transform=`translate(${e.clientX}px,${e.clientY}px)`},true);
document.addEventListener('mousedown',()=>{c.style.scale='0.85'},true);
document.addEventListener('mouseup',()=>{c.style.scale='1'},true);
window.__scroll=(y,ms=1200)=>{const s=scrollY,d=y-s,t0=performance.now();const step=n=>{const t=Math.min(1,(n-t0)/ms);const e=t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;scrollTo(0,s+d*e);if(t<1)requestAnimationFrame(step)};requestAnimationFrame(step)};
return 'ok'})()
