import {Vector3} from 'three';

/** Exact exponential velocity integration makes braking independent of FPS. */
export class FlightMotion {
  private velocity=new Vector3();
  private target=new Vector3();
  private displacement=new Vector3();
  reset(){this.velocity.set(0,0,0);}
  stopVertical(){this.velocity.y=0;}
  step(side:number,forward:number,up:number,yaw:number,pitch:number,fast:boolean,dt:number){
    const speed=fast?65:22;
    this.target.set(Math.cos(yaw)*side-Math.sin(yaw)*Math.cos(pitch)*forward,
      Math.sin(pitch)*forward+up,-Math.sin(yaw)*side-Math.cos(yaw)*Math.cos(pitch)*forward);
    if(this.target.lengthSq()>1)this.target.normalize();
    this.target.multiplyScalar(speed);
    const response=4,decay=Math.exp(-response*dt);
    this.displacement.copy(this.velocity).sub(this.target).multiplyScalar((1-decay)/response).addScaledVector(this.target,dt);
    this.velocity.lerp(this.target,1-decay);
    return this.displacement;
  }
}
