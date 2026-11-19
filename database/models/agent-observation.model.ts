import { Schema, model, models, type Document, type Model } from "mongoose";
export interface IAgentObservation extends Document {
  userId: string;
  symbol: string;
  watchId: string;
  scheduledAt: Date;
  observedAt: Date;
  status: "ok" | "failed";
  quote?: Record<string,number>;
  detail?: string;
}
const AgentObservationSchema=new Schema<IAgentObservation>({
  userId:{type:String,required:true,index:true},symbol:{type:String,required:true},
  watchId:{type:String,required:true},scheduledAt:{type:Date,required:true},
  observedAt:{type:Date,required:true},status:{type:String,enum:["ok","failed"],required:true},
  quote:{type:Schema.Types.Mixed},detail:{type:String}
},{timestamps:false});
AgentObservationSchema.index({watchId:1,scheduledAt:1},{unique:true});
AgentObservationSchema.index({userId:1,observedAt:-1});
export const AgentObservation:Model<IAgentObservation>=
  (models?.AgentObservation as Model<IAgentObservation>)||model<IAgentObservation>("AgentObservation",AgentObservationSchema);
