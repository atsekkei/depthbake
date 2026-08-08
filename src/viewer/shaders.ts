export const VS = `#version 300 es
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.-1.,0.,1.);}`;

export const FS = `#version 300 es
precision highp float;
uniform sampler2D uImg,uDep;
uniform vec2 uRes,uDRes,uCur;
uniform float uT,uTanF,uFar,uRad,uSky,uEdge;
uniform int uMode,uView;
out vec4 o;

float dsp(vec2 uv){
  vec2 stx=vec2(uv.x,1.0-uv.y)*uDRes-0.5;
  vec2 f=fract(stx);
  ivec2 i0=ivec2(floor(stx));
  ivec2 mx=ivec2(uDRes)-1;
  float a=texelFetch(uDep,clamp(i0,ivec2(0),mx),0).r;
  float b=texelFetch(uDep,clamp(i0+ivec2(1,0),ivec2(0),mx),0).r;
  float c=texelFetch(uDep,clamp(i0+ivec2(0,1),ivec2(0),mx),0).r;
  float d=texelFetch(uDep,clamp(i0+ivec2(1,1),ivec2(0),mx),0).r;
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}
float toZ(float d){return 1.0/mix(1.0/uFar,1.0,d);}
vec3 wpos(vec2 uv,float d){
  float z=toZ(d);
  vec2 s=(uv*2.-1.)*vec2(uRes.x/uRes.y,1.)*uTanF;
  return vec3(s*z,-z);
}
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  float d0=dsp(uv);
  vec3 alb=texture(uImg,uv).rgb;
  bool sky=d0<uSky;
  vec3 pos=wpos(uv,d0);
  float z=-pos.z;
  vec3 n=normalize(cross(dFdx(pos),dFdy(pos)));
  if(dot(n,-pos)<0.)n=-n;
  float rel=length(vec2(dFdx(z),dFdy(z)))/z;
  float edge=1.0-smoothstep(uEdge,uEdge*3.0,rel);

  if(uView==1){
    vec3 c=vec3(d0);
    c=mix(c,vec3(.9,.3,.2),(1.0-edge)*.8);
    if(sky)c=vec3(.05,.1,.25);
    o=vec4(c,1.);return;
  }
  if(uView==2){o=vec4(sky?vec3(.05):n*.5+.5,1.);return;}

  float dc=dsp(uCur);
  vec3 pc=wpos(uCur,dc);
  float on=dc<uSky?0.:1.;
  float asp=uRes.x/uRes.y;
  float dn=length(pos-pc)/uRad;

  vec3 col=alb;
  if(uMode==1){
    float g=exp(-dn*dn*1.1);
    if(sky){col=alb*.22;}
    else{
      vec3 lp=pc+vec3(0.,.25,.8)*uRad;
      float lam=.2+.8*max(dot(n,normalize(lp-pos)),0.);
      col=col*.18+col*g*lam*3.6*on+col*(1.-on)*.82;
    }
  }else if(!sky){
    if(uMode==0){
      float w=sin(dn*13.-uT*5.)*exp(-dn*1.15);
      col+=max(w,0.)*.5*edge*on*vec3(.85,.95,1.1);
    }else{
      float r=length(pos),rc=length(pc);
      float ad=abs(r-rc);
      col+=vec3(.22,.16,.05)*(1.-smoothstep(0.,.6*uRad,ad))*.5*on;
      float band=1.-smoothstep(0.,.05*uRad+.01,ad);
      col=mix(col,vec3(1.,.85,.4),band*.8*on*edge);
    }
  }
  float m=smoothstep(.012,.005,length((uv-uCur)*vec2(asp,1.)));
  col=mix(col,vec3(1.),m*.9);
  o=vec4(col,1.);
}`;
