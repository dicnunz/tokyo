import * as THREE from 'three';
import {GeoFrame} from './geo';
import {saveStreetReturn,type StreetPose} from './street-return';

export type NeighborhoodPlace={id:'cafe'|'clothing-store'|'apartment'|'station';title:string;lat:number;lon:number;yaw:number;entranceLat:number;entranceLon:number;source:string;note?:string};
export class Neighborhood{
 places:NeighborhoodPlace[]=[];
 private nearby?:NeighborhoodPlace;
 private destination?:NeighborhoodPlace;
 private currentPose?:StreetPose;
 private label=document.querySelector<HTMLButtonElement>('#enter-space')!;
 private dialog=document.querySelector<HTMLDialogElement>('#spaces-dialog')!;
 private navigation=document.querySelector<HTMLElement>('#neighborhood-navigation')!;
 private lastUpdate=-Infinity;
 constructor(private visit:(place:NeighborhoodPlace)=>Promise<void>){
  this.label.addEventListener('click',()=>this.enter());
  document.querySelector('#spaces-button')!.addEventListener('click',()=>{document.exitPointerLock();this.dialog.showModal();});
  document.querySelector('#close-spaces')!.addEventListener('click',()=>this.dialog.close());
  document.querySelector('#cancel-navigation')!.addEventListener('click',()=>{this.destination=undefined;this.navigation.hidden=true;});
 }
 async load(){
  const response=await fetch('/district/shibuya/places.json');if(!response.ok)throw Error('Shibuya entrances are being prepared.');
  const manifest=await response.json();this.places=manifest.places;
  const list=document.querySelector('#spaces')!;list.replaceChildren();
  for(const place of this.places){
   const button=document.createElement('button');button.className='space-card';
   const name=document.createElement('strong');name.textContent=place.title;const caption=document.createElement('span');caption.textContent=place.id==='station'?'Measured underground station':'Furnished Blender interior';
   const action=document.createElement('small');action.textContent='Walk to the entrance ↗';button.append(name,caption,action);
   button.addEventListener('click',()=>{this.dialog.close();this.destination=place;void this.visit(place).catch(error=>{this.navigation.hidden=false;document.querySelector('#navigation-text')!.textContent=String(error.message||error);});});list.append(button);
  }
 }
 update(frame:GeoFrame,position:THREE.Vector3,yaw:number,pitch:number,walking:boolean,settled:boolean,name:string){
  if(performance.now()-this.lastUpdate<100)return;this.lastUpdate=performance.now();
  this.currentPose={...frame.toGeo(position.x,position.y,position.z),yaw,pitch,name};this.nearby=undefined;let distance=Infinity;
  if(walking&&settled)for(const place of this.places){
   const point=frame.toLocal(place.lat,place.lon),d=Math.hypot(point.x-position.x,point.z-position.z);
   if(d<8&&d<distance){this.nearby=place;distance=d;}
  }
  this.label.hidden=!this.nearby;
  if(this.nearby)this.label.textContent='E  '+(this.nearby.id==='station'?'Enter Shibuya Station':'Enter '+this.nearby.title);
  this.navigation.hidden=!this.destination||!walking;
  if(this.destination){const point=frame.toLocal(this.destination.lat,this.destination.lon),d=Math.hypot(point.x-position.x,point.z-position.z),angle=Math.atan2(-(point.x-position.x),-(point.z-position.z));
   document.querySelector<HTMLElement>('#navigation-arrow')!.style.transform=`rotate(${(yaw-angle)*180/Math.PI}deg)`;
   document.querySelector('#navigation-text')!.textContent=d<8?`${this.destination.title} · Entrance nearby`:`${this.destination.title} · ${Math.round(d)} m`;
  }
 }
 enter(){
  if(!this.nearby||!this.currentPose)return false;
  saveStreetReturn(this.currentPose);document.exitPointerLock();
  location.href=this.nearby.id==='station'?'/underground.html?dataset=shibuya&floor=b2&entrance=street':`/interior.html?space=${encodeURIComponent(this.nearby.id)}`;return true;
 }
 clear(){this.nearby=undefined;this.label.hidden=true;this.lastUpdate=-Infinity;}
 get diagnostics(){return{places:this.places.length,nearby:this.nearby?.id,destination:this.destination?.id};}
}
