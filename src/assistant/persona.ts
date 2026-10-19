/** Telegram identities are channel facts, not model-generated file IDs. */
export type TelegramSticker = {
  file_id:string; file_unique_id:string; emoji?:string; set_name?:string;
  is_animated:boolean; is_video:boolean;
};
export type TelegramMaterial = {sticker?:TelegramSticker;replySticker?:TelegramSticker;stickerSets?:string[]};
export type CollectedSticker = {id:string;fileId:string;emoji?:string;setName?:string;description?:string;source:{inputId:string;reference:string}};
export type TelegramExpression = ({kind:"sticker";sticker:CollectedSticker} |
  {kind:"reaction";emoji:string;messageId:number}) & {explicit:boolean;inputId:string;operationId:string};
export type TelegramInteractions = {
  getStickerSet:(name:string)=>Promise<TelegramSticker[]>;
  express:(action:TelegramExpression)=>Promise<void>;
};
