/* Embedded material loading and procedural detail; works on file:// too. */
window.BB_SURFACE_FX = {
  textures(THREE) {
    const textures = {};
    for (const [name,data] of Object.entries(window.BB_SURFACES)) {
      const image=new Image(),texture=new THREE.Texture(image);
      image.onload=()=>{texture.needsUpdate=true;};image.src=data;
      texture.colorSpace=THREE.SRGBColorSpace;texture.wrapS=texture.wrapT=THREE.MirroredRepeatWrapping;
      texture.repeat.set(name==='tuff'?1:12,name==='tuff'?1:8);textures[name]=texture;
    }
    return textures;
  },
  detailProp(THREE,kind,group,material,random) {
    const box=(w,h,d,x,y,z)=>{const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material);m.position.set(x,y,z);group.add(m);};
    if(kind==='car') {
      for(const z of [-12.2,12.2]) {for(const x of [-7,8]) {box(.35,13,.3,x,12,z);box(3,.65,.6,x-2,17,z);}box(35,.6,.5,0,5,z);}
      for(let k=0;k<5;k++) box(.6,4,.5,31,11,-4+k*2);
    } else if(kind==='crate') {
      for(const z of [-7.2,7.2]) for(let y=2;y<13;y+=3) box(12,.18,.2,0,y,z);
      for(const x of [-5.5,5.5]) for(const y of [2,12]) box(.5,.5,.3,x,y,7.4);
    } else if(kind==='boulder'||kind==='moai') {
      for(let i=0;i<7;i++) {const m=new THREE.Mesh(new THREE.IcosahedronGeometry(.2+random()*.4,0),material);m.position.set((random()-.5)*12,kind==='moai'?5+random()*32:2+random()*9,8.7);group.add(m);}
    }
  }
};
