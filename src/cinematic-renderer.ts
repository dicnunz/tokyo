import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

/** Linear-light presentation; survey maps and their material factors stay intact. */
export class CinematicRenderer {
  readonly composer: EffectComposer;
  readonly ready: Promise<void>;
  private readonly bloom: UnrealBloomPass;
  private readonly grade: ShaderPass;
  private readonly output = new OutputPass();
  private readonly antialias = new ShaderPass(FXAAShader);
  private readonly renderPass: RenderPass;
  private sky?: THREE.DataTexture;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private quality: 'interactive' | 'capture' = 'interactive';
  private disposed = false;
  private camera: THREE.Camera;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, camera: THREE.Camera) {
    this.camera = camera;
    // Three renders the offscreen scene in linear light. OutputPass performs
    // the only tone mapping and sRGB conversion, including unlit survey maps.
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const target = new THREE.WebGLRenderTarget(1, 1, {type: THREE.HalfFloatType, depthBuffer: true});
    this.composer = new EffectComposer(renderer, target);
    this.renderPass = new RenderPass(scene, camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.085, 0.35, 1.3);
    this.bloom.enabled = false;
    this.grade = new ShaderPass({
      uniforms: { tDiffuse: {value: null} },
      vertexShader: `varying vec2 vUv;
        void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader: `uniform sampler2D tDiffuse;varying vec2 vUv;
        void main(){
          vec4 source=texture2D(tDiffuse,vUv);
          vec3 c=max(source.rgb,vec3(0.0));
          float luminance=dot(c,vec3(0.2126,0.7152,0.0722));
          float shadows=1.0-smoothstep(0.04,0.42,luminance);
          float highlights=smoothstep(0.38,1.0,luminance);
          c*=vec3(1.0)+shadows*vec3(-0.012,0.002,0.015)+highlights*vec3(0.014,0.004,-0.010);
          // A restrained toe gives separation without crushing photographed detail.
          c=mix(c,c*smoothstep(0.0,0.025,luminance),0.06);
          gl_FragColor=vec4(c,source.a);
        }`,
    });
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.grade);
    this.composer.addPass(this.output);
    // FXAA expects sRGB input, so it deliberately follows OutputPass.
    this.composer.addPass(this.antialias);
    scene.background = new THREE.Color('#b9dcf5');
    scene.fog = new THREE.Fog('#c9e2f2', 450, 1150);
    const size = renderer.getSize(new THREE.Vector2());
    this.resize(size.x, size.y);
    this.ready = new RGBELoader().loadAsync('/cinema/sky.hdr').then(texture => {
      if(this.disposed){texture.dispose();return;}
      texture.mapping = THREE.EquirectangularReflectionMapping;
      this.sky = texture;
      scene.background = texture;
      scene.backgroundIntensity = 0.9;
      scene.backgroundBlurriness = 0;
    }).catch(error => { console.warn('Cinematic sky unavailable; using atmospheric background.', error); });
  }

  render() {
    if(this.disposed)return;
    // FrameMonitor can change native resolution while walking. Keep targets in
    // lockstep so adaptive resolution still saves real GPU work.
    if(this.pixelRatio !== this.renderer.getPixelRatio())this.resize(this.width,this.height);
    const autoReset=this.renderer.info.autoReset;
    this.renderer.info.autoReset=false;this.renderer.info.reset();
    try{
      // Native MSAA resolves directly into the canvas. Walking avoids four
      // full-screen HDR passes and their intermediate memory bandwidth.
      if(this.quality==='interactive')this.renderer.render(this.scene,this.camera);
      else this.composer.render();
    }finally{this.renderer.info.autoReset=autoReset;}
  }

  resize(width: number, height: number) {
    this.width = Math.max(1,width);this.height = Math.max(1,height);
    this.pixelRatio = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(this.width,this.height);
    this.antialias.uniforms.resolution.value.set(1/(this.width*this.pixelRatio),1/(this.height*this.pixelRatio));
  }

  setQuality(quality: 'interactive' | 'capture') {
    this.quality = quality;
    this.bloom.enabled = quality === 'capture';
    const samples = quality === 'capture' ? Math.min(4,this.renderer.capabilities.maxSamples) : 0;
    for(const target of [this.composer.renderTarget1,this.composer.renderTarget2]){
      if(target.samples!==samples){target.samples=samples;target.dispose();}
    }
    this.antialias.enabled = samples === 0;
  }

  get status(){return {quality:this.quality,skyLoaded:!!this.sky,pixelRatio:this.pixelRatio,passes:this.quality==='interactive'?1:5,reversedDepth:this.renderer.capabilities.reversedDepthBuffer};}

  dispose() {
    if(this.disposed)return;this.disposed=true;
    if(this.scene.background===this.sky)this.scene.background=null;
    this.sky?.dispose();this.renderPass.dispose();this.bloom.dispose();this.grade.dispose();this.output.dispose();this.antialias.dispose();this.composer.dispose();
  }
}
