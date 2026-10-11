export const VIEWER_SCRIPT = String.raw`
(() => {
  history.scrollRestoration='manual';
  const panels=Array.from(document.querySelectorAll('.diagram-panel'));
  const links=Array.from(document.querySelectorAll('nav a[data-diagram]'));
  const picker=document.getElementById('diagram-picker');
  const search=document.getElementById('diagram-search');
  const empty=document.getElementById('nav-empty');
  const states=new Map();
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const selected=()=>panels.find(panel=>!panel.hidden);
  function paint(panel){const state=states.get(panel.id);if(!state)return;panel.querySelector('.canvas-plane').style.transform='translate('+state.x+'px,'+state.y+'px) scale('+state.scale+')';panel.querySelector('.zoom-level').textContent=Math.round(state.scale*100)+'%';}
  function center(panel,scale){const state=states.get(panel.id);if(!state)return;const rect=panel.querySelector('.canvas').getBoundingClientRect();state.scale=clamp(scale,.05,4);state.x=((rect.width||800)-state.width*state.scale)/2;state.y=((rect.height||500)-state.height*state.scale)/2;paint(panel);}
  function fit(panel){const state=states.get(panel.id);if(!state)return;const rect=panel.querySelector('.canvas').getBoundingClientRect();center(panel,Math.min(((rect.width||800)-56)/state.width,((rect.height||500)-56)/state.height,1));}
  function initialView(panel){const state=states.get(panel.id);if(!state)return;fit(panel);if(state.scale>=.75)return;center(panel,.75);const focus=panel.querySelector('.diagram-svg .node[id*="'+panel.dataset.focus+'"]');if(!focus)return;const canvas=panel.querySelector('.canvas').getBoundingClientRect();const bounds=focus.getBoundingClientRect();const worldX=(bounds.left+bounds.width/2-canvas.left-state.x)/state.scale,worldY=(bounds.top+bounds.height/2-canvas.top-state.y)/state.scale;const topDown=panel.dataset.direction==='TD';state.x=(canvas.width||800)*(topDown ? .5 : .4)-worldX*state.scale;state.y=(canvas.height||500)*(topDown?.23:.5)-worldY*state.scale;paint(panel);}
  function zoom(panel,factor,point){const state=states.get(panel.id);if(!state)return;const rect=panel.querySelector('.canvas').getBoundingClientRect();const anchor=point||{x:(rect.width||800)/2,y:(rect.height||500)/2};const scale=clamp(state.scale*factor,.05,4);state.x=anchor.x-(anchor.x-state.x)*scale/state.scale;state.y=anchor.y-(anchor.y-state.y)*scale/state.scale;state.scale=scale;paint(panel);}
  function select(id){const panel=panels.find(p=>p.id===id)||panels[0];if(!panel)return;panels.forEach(p=>{p.hidden=p!==panel;});links.forEach(link=>{if(link.dataset.diagram===panel.id)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');});picker.value=panel.id;document.getElementById('view-position').textContent=String(panels.indexOf(panel)+1).padStart(2,'0')+' / '+String(panels.length).padStart(2,'0');document.title=panel.dataset.title+' · Mermaider';if(states.has(panel.id)&&!states.get(panel.id).visited){initialView(panel);states.get(panel.id).visited=true;} }
  function hashId(){try{return decodeURIComponent(location.hash.slice(1));}catch{return '';}}
  function navigate(id){if(location.hash!=='#'+id)history.pushState(null,'','#'+id);select(id);window.scrollTo(0,0);}
  document.querySelector('.skip-link').addEventListener('click',event=>{event.preventDefault();document.getElementById('main').focus();});
  select(hashId());
  window.addEventListener('hashchange',()=>select(hashId()));window.addEventListener('popstate',()=>select(hashId()));
  picker.addEventListener('change',()=>navigate(picker.value));
  links.forEach(link=>link.addEventListener('click',event=>{if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();search.value='';filter('');navigate(link.dataset.diagram);}));
  function filter(query){let count=0;links.forEach(link=>{const match=link.dataset.search.includes(query.toLowerCase());link.hidden=!match;if(match)count++;});empty.hidden=count>0;}
  search.addEventListener('input',()=>filter(search.value));
  panels.forEach(panel=>{
    const canvas=panel.querySelector('.canvas');
    panel.querySelector('[aria-label="Fit diagram"]').addEventListener('click',()=>fit(panel));
    panel.querySelector('[aria-label="Actual size"]').addEventListener('click',()=>center(panel,1));
    panel.querySelector('[aria-label="Zoom in"]').addEventListener('click',()=>zoom(panel,1.25));
    panel.querySelector('[aria-label="Zoom out"]').addEventListener('click',()=>zoom(panel,.8));
    let drag=null;
    canvas.addEventListener('pointerdown',event=>{if(event.button!==0||event.target.closest('a,button'))return;const state=states.get(panel.id);if(!state)return;drag={id:event.pointerId,x:event.clientX,y:event.clientY};canvas.classList.add('is-dragging');canvas.setPointerCapture(event.pointerId);canvas.focus({preventScroll:true});});
    canvas.addEventListener('pointermove',event=>{if(!drag||drag.id!==event.pointerId)return;const state=states.get(panel.id);state.x+=event.clientX-drag.x;state.y+=event.clientY-drag.y;drag.x=event.clientX;drag.y=event.clientY;paint(panel);});
    const endDrag=()=>{drag=null;canvas.classList.remove('is-dragging');};canvas.addEventListener('pointerup',endDrag);canvas.addEventListener('pointercancel',endDrag);canvas.addEventListener('lostpointercapture',endDrag);
    canvas.addEventListener('wheel',event=>{if(!event.ctrlKey&&!event.metaKey)return;event.preventDefault();const rect=canvas.getBoundingClientRect();zoom(panel,Math.exp(-event.deltaY*.008),{x:event.clientX-rect.left,y:event.clientY-rect.top});},{passive:false});
    canvas.addEventListener('keydown',event=>{const state=states.get(panel.id);if(!state)return;const amount=event.shiftKey?100:35;const moves={ArrowLeft:[amount,0],ArrowRight:[-amount,0],ArrowUp:[0,amount],ArrowDown:[0,-amount]};if(moves[event.key]){event.preventDefault();state.x+=moves[event.key][0];state.y+=moves[event.key][1];paint(panel);}else if(['+','=','-','0','1'].includes(event.key)){event.preventDefault();if(event.key==='0')fit(panel);else if(event.key==='1')center(panel,1);else zoom(panel,event.key==='-' ? 0.8 : 1.25);}});
  });
  window.addEventListener('resize',()=>{const panel=selected();if(panel)fit(panel);});
  async function render(){
    if(document.fonts)await document.fonts.ready;
    mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'base',htmlLabels:false,fontFamily:'Arial, Helvetica, sans-serif',fontSize:16,themeVariables:{fontFamily:'Arial, Helvetica, sans-serif',fontSize:'16px',primaryColor:'#ffffff',primaryTextColor:'#111111',primaryBorderColor:'#111111',lineColor:'#686868',secondaryColor:'#f3f3f3',tertiaryColor:'#ffffff',edgeLabelBackground:'#ffffff',clusterBkg:'#f3f3f3',clusterBorder:'#c8c8c8',actorBkg:'#ffffff',actorBorder:'#111111',actorTextColor:'#111111',signalColor:'#686868',signalTextColor:'#111111',labelBoxBkgColor:'#ffffff',labelBoxBorderColor:'#c8c8c8',labelTextColor:'#111111',entityBkg:'#ffffff',entityBorder:'#111111',entityTextColor:'#111111'},flowchart:{htmlLabels:false,wrappingWidth:340,nodeSpacing:42,rankSpacing:85,curve:'linear',padding:18},er:{diagramPadding:30,minEntityWidth:150,entityPadding:18},sequence:{actorMargin:70,diagramMarginX:35,diagramMarginY:25},maxTextSize:1000000,maxEdges:10000,suppressErrorRendering:true});
    const measurement=document.createElement('div');measurement.id='mermaider-measure';measurement.className='measurement';measurement.setAttribute('aria-hidden','true');document.body.append(measurement);
    for(const panel of panels){
      const output=panel.querySelector('.diagram-svg');
      try{
        const source=panel.querySelector('.mermaid-source').textContent;
        const result=await mermaid.render('mermaider-svg-'+panel.id,source,measurement);
        output.innerHTML=result.svg;
        if(result.bindFunctions)result.bindFunctions(output);
        const svg=output.querySelector('svg');if(!svg)throw new Error('Renderer returned no SVG');
        const box=(svg.getAttribute('viewBox')||'0 0 800 500').trim().split(/\s+/).map(Number);
        const width=Number.isFinite(box[2])&&box[2]>0?box[2]:800,height=Number.isFinite(box[3])&&box[3]>0?box[3]:500;
        svg.setAttribute('width',String(width));svg.setAttribute('height',String(height));svg.style.maxWidth='none';
        const plane=panel.querySelector('.canvas-plane');plane.style.width=width+'px';plane.style.height=height+'px';
        states.set(panel.id,{width,height,scale:1,x:0,y:0,visited:false});
        panel.querySelector('.render-loading').hidden=true;panel.querySelectorAll('.zoom-controls button').forEach(button=>button.disabled=false);
        panel.dataset.rendered='true';
        if(!panel.hidden){initialView(panel);states.get(panel.id).visited=true;}
      }catch(error){const status=panel.querySelector('.render-loading');status.className='render-error';status.textContent='This diagram could not be rendered. Review the Mermaid source below. '+String(error);panel.dataset.rendered='error';}
    }
    measurement.remove();document.documentElement.dataset.rendered='true';window.scrollTo(0,0);
  }
  render().catch(error=>{document.documentElement.dataset.rendered='error';document.querySelectorAll('.render-loading').forEach(node=>{node.className='render-error';node.textContent='Diagram rendering could not start. '+String(error);});});
})();
`;
