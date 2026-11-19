import { Schema, model, models, type Document, type Model } from "mongoose";
export interface IAgentWatch extends Document {
  userId: string;
  symbol: string;
  intervalMinutes: number;
  active: boolean;
  nextRunAt: Date;
  lastRunAt?: Date;
  lastStatus?: "ok" | "failed";
  lastError?: string;
  leaseOwner?: string;
  leaseUntil?: Date;
}
const AgentWatchSchema=new Schema<IAgentWatch>({
  userId:{type:String,required:true,index:true},
  symbol:{type:String,required:true,uppercase:true,trim:true},
  intervalMinutes:{type:Number,required:true,min:5,max:1440},
  active:{type:Boolean,required:true,default:true},
  nextRunAt:{type:Date,required:true,default:Date.now,index:true},
  lastRunAt:{type:Date},lastStatus:{type:String,enum:["ok","failed"]},
  lastError:{type:String},leaseOwner:{type:String},leaseUntil:{type:Date}
},{timestamps:true});
AgentWatchSchema.index({userId:1,symbol:1},{unique:true});
AgentWatchSchema.index({active:1,nextRunAt:1,leaseUntil:1});
export const AgentWatch:Model<IAgentWatch>=
  (models?.AgentWatch as Model<IAgentWatch>)||model<IAgentWatch>("AgentWatch",AgentWatchSchema);
