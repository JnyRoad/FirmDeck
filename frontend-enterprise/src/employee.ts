import type { AgentProfileRead, AgentResourceBindingRead, AgentResourceType } from './types';
import {
  isEmployeeOwnedBy,
  isEnterpriseAdmin,
  isGalleryEmployee,
  type EnterpriseAuthUser,
} from './auth';

import avatarAfterSales from './assets/firmdeck/firmdeck-avatar-after-sales.png';
import avatarAiImageArtistF from './assets/firmdeck/firmdeck-avatar-ai-image-artist-f.png';
import avatarAiImageArtistM from './assets/firmdeck/firmdeck-avatar-ai-image-artist-m.png';
import avatarAiVideoArtistF from './assets/firmdeck/firmdeck-avatar-ai-video-artist-f.png';
import avatarAiVideoArtistM from './assets/firmdeck/firmdeck-avatar-ai-video-artist-m.png';
import avatarBrandDesign from './assets/firmdeck/firmdeck-avatar-brand-design.png';
import avatarChefF from './assets/firmdeck/firmdeck-avatar-chef-f.png';
import avatarChefM from './assets/firmdeck/firmdeck-avatar-chef-m.png';
import avatarCommerce from './assets/firmdeck/firmdeck-avatar-commerce.png';
import avatarCommunityOpsF from './assets/firmdeck/firmdeck-avatar-community-ops-f.png';
import avatarCommunityOpsM from './assets/firmdeck/firmdeck-avatar-community-ops-m.png';
import avatarContentResearcherF from './assets/firmdeck/firmdeck-avatar-content-researcher-f.png';
import avatarContentResearcherM from './assets/firmdeck/firmdeck-avatar-content-researcher-m.png';
import avatarCopywriterF from './assets/firmdeck/firmdeck-avatar-copywriter-f.png';
import avatarCopywriterM from './assets/firmdeck/firmdeck-avatar-copywriter-m.png';
import avatarCourierF from './assets/firmdeck/firmdeck-avatar-courier-f.png';
import avatarCourierM from './assets/firmdeck/firmdeck-avatar-courier-m.png';
import avatarCustomerService from './assets/firmdeck/firmdeck-avatar-customer-service.png';
import avatarData from './assets/firmdeck/firmdeck-avatar-data.png';
import avatarDefault from './assets/firmdeck/firmdeck-avatar-default.png';
import avatarDesignerF from './assets/firmdeck/firmdeck-avatar-designer-f.png';
import avatarDesignerM from './assets/firmdeck/firmdeck-avatar-designer-m.png';
import avatarDoctorF from './assets/firmdeck/firmdeck-avatar-doctor-f.png';
import avatarDoctorM from './assets/firmdeck/firmdeck-avatar-doctor-m.png';
import avatarDouyinOpsF from './assets/firmdeck/firmdeck-avatar-douyin-ops-f.png';
import avatarDouyinOpsM from './assets/firmdeck/firmdeck-avatar-douyin-ops-m.png';
import avatarDriverF from './assets/firmdeck/firmdeck-avatar-driver-f.png';
import avatarDriverM from './assets/firmdeck/firmdeck-avatar-driver-m.png';
import avatarEcommerceServiceF from './assets/firmdeck/firmdeck-avatar-ecommerce-service-f.png';
import avatarEcommerceServiceM from './assets/firmdeck/firmdeck-avatar-ecommerce-service-m.png';
import avatarItSupport from './assets/firmdeck/firmdeck-avatar-it-support.png';
import avatarKnowledge from './assets/firmdeck/firmdeck-avatar-knowledge.png';
import avatarKolLiaisonF from './assets/firmdeck/firmdeck-avatar-kol-liaison-f.png';
import avatarKolLiaisonM from './assets/firmdeck/firmdeck-avatar-kol-liaison-m.png';
import avatarLawyerF from './assets/firmdeck/firmdeck-avatar-lawyer-f.png';
import avatarLawyerM from './assets/firmdeck/firmdeck-avatar-lawyer-m.png';
import avatarListingDesignerF from './assets/firmdeck/firmdeck-avatar-listing-designer-f.png';
import avatarListingDesignerM from './assets/firmdeck/firmdeck-avatar-listing-designer-m.png';
import avatarLivestreamControlF from './assets/firmdeck/firmdeck-avatar-livestream-control-f.png';
import avatarLivestreamControlM from './assets/firmdeck/firmdeck-avatar-livestream-control-m.png';
import avatarLivestreamHostF from './assets/firmdeck/firmdeck-avatar-livestream-host-f.png';
import avatarLivestreamHostM from './assets/firmdeck/firmdeck-avatar-livestream-host-m.png';
import avatarMarketing from './assets/firmdeck/firmdeck-avatar-marketing.png';
import avatarNurseF from './assets/firmdeck/firmdeck-avatar-nurse-f.png';
import avatarNurseM from './assets/firmdeck/firmdeck-avatar-nurse-m.png';
import avatarOperations from './assets/firmdeck/firmdeck-avatar-operations.png';
import avatarOps from './assets/firmdeck/firmdeck-avatar-ops.png';
import avatarOverall from './assets/firmdeck/firmdeck-avatar-overall.png';
import avatarPhotographerF from './assets/firmdeck/firmdeck-avatar-photographer-f.png';
import avatarPhotographerM from './assets/firmdeck/firmdeck-avatar-photographer-m.png';
import avatarProcurement from './assets/firmdeck/firmdeck-avatar-procurement.png';
import avatarProductCuratorF from './assets/firmdeck/firmdeck-avatar-product-curator-f.png';
import avatarProductCuratorM from './assets/firmdeck/firmdeck-avatar-product-curator-m.png';
import avatarProject from './assets/firmdeck/firmdeck-avatar-project.png';
import avatarQuality from './assets/firmdeck/firmdeck-avatar-quality.png';
import avatarRetailF from './assets/firmdeck/firmdeck-avatar-retail-f.png';
import avatarRetailM from './assets/firmdeck/firmdeck-avatar-retail-m.png';
import avatarSales from './assets/firmdeck/firmdeck-avatar-sales.png';
import avatarService from './assets/firmdeck/firmdeck-avatar-service.png';
import avatarShortVideoOpsF from './assets/firmdeck/firmdeck-avatar-short-video-ops-f.png';
import avatarShortVideoOpsM from './assets/firmdeck/firmdeck-avatar-short-video-ops-m.png';
import avatarStoryboardArtistF from './assets/firmdeck/firmdeck-avatar-storyboard-artist-f.png';
import avatarStoryboardArtistM from './assets/firmdeck/firmdeck-avatar-storyboard-artist-m.png';
import avatarStrategy from './assets/firmdeck/firmdeck-avatar-strategy.png';
import avatarStylistF from './assets/firmdeck/firmdeck-avatar-stylist-f.png';
import avatarStylistM from './assets/firmdeck/firmdeck-avatar-stylist-m.png';
import avatarTeacherF from './assets/firmdeck/firmdeck-avatar-teacher-f.png';
import avatarTeacherM from './assets/firmdeck/firmdeck-avatar-teacher-m.png';
import avatarTrainerF from './assets/firmdeck/firmdeck-avatar-trainer-f.png';
import avatarTrainerM from './assets/firmdeck/firmdeck-avatar-trainer-m.png';
import avatarTraining from './assets/firmdeck/firmdeck-avatar-training.png';
import avatarVideoEditorF from './assets/firmdeck/firmdeck-avatar-video-editor-f.png';
import avatarVideoEditorM from './assets/firmdeck/firmdeck-avatar-video-editor-m.png';
import avatarWaiterF from './assets/firmdeck/firmdeck-avatar-waiter-f.png';
import avatarWaiterM from './assets/firmdeck/firmdeck-avatar-waiter-m.png';
import avatarWechatArticleEditorF from './assets/firmdeck/firmdeck-avatar-wechat-article-editor-f.png';
import avatarWechatArticleEditorM from './assets/firmdeck/firmdeck-avatar-wechat-article-editor-m.png';
import avatarWechatChannelsOpsF from './assets/firmdeck/firmdeck-avatar-wechat-channels-ops-f.png';
import avatarWechatChannelsOpsM from './assets/firmdeck/firmdeck-avatar-wechat-channels-ops-m.png';
import avatarXiaohongshuOpsF from './assets/firmdeck/firmdeck-avatar-xiaohongshu-ops-f.png';
import avatarXiaohongshuOpsM from './assets/firmdeck/firmdeck-avatar-xiaohongshu-ops-m.png';

export type EmployeeProfile = {
  roleKey: string;
  roleName: string;
  avatarText: string;
  avatarTone: string;
  avatarKind: 'preset' | 'upload';
  avatarPreset: string;
  avatarImage: string;
  onboardedAt: string;
  workStyles: string[];
  expertiseTags: string[];
  workModes: string[];
};

export type EmployeeAvatarPreset = {
  key: string;
  label: string;
  text: string;
  tone: string;
};

export type EmployeeTemplate = {
  key: string;
  roleName: string;
  avatarText: string;
  avatarTone: string;
  avatarPreset: string;
  description: string;
  workStyles: string[];
  expertiseTags: string[];
  workModes: string[];
};

type EmployeeAgentLike = {
  id?: string;
  name?: string;
  is_overall?: boolean;
  metadata?: Record<string, unknown>;
};

export const EMPLOYEE_AVATAR_PRESETS: EmployeeAvatarPreset[] = [
  { key: 'service-orbit', label: '研发员工', text: '研', tone: 'teal' },
  { key: 'after-sales-seal', label: '行政员工', text: '行', tone: 'copper' },
  { key: 'knowledge-node', label: '知识运营员工', text: '知', tone: 'olive' },
  { key: 'commerce-compass', label: '财务员工', text: '财', tone: 'blue' },
  { key: 'ops-grid', label: '人事员工', text: '人', tone: 'ink' },
  { key: 'quality-star', label: '法务员工', text: '法', tone: 'gold' },
  { key: 'sales-handshake', label: '销售员工', text: '销', tone: 'cobalt' },
  { key: 'marketing-spark', label: '市场员工', text: '市', tone: 'coral' },
  { key: 'procurement-check', label: '采购员工', text: '采', tone: 'forest' },
  { key: 'project-board', label: '项目管理员工', text: '项', tone: 'charcoal' },
  { key: 'data-insight', label: '数据分析员工', text: '数', tone: 'navy' },
  { key: 'customer-service', label: '客服员工', text: '客', tone: 'rose' },
  { key: 'operations-flow', label: '运营员工', text: '运', tone: 'emerald' },
  { key: 'it-support', label: 'IT支持员工', text: 'IT', tone: 'slate' },
  { key: 'brand-design', label: '品牌设计员工', text: '品', tone: 'plum' },
  { key: 'training-coach', label: '培训员工', text: '培', tone: 'amber' },
  { key: 'strategy-compass', label: '战略规划员工', text: '略', tone: 'indigo' },
  { key: 'teacher-f', label: '教师(女)', text: '教', tone: 'sky' },
  { key: 'teacher-m', label: '教师(男)', text: '教', tone: 'sky' },
  { key: 'doctor-f', label: '医生(女)', text: '医', tone: 'mint' },
  { key: 'doctor-m', label: '医生(男)', text: '医', tone: 'mint' },
  { key: 'nurse-f', label: '护士(女)', text: '护', tone: 'seafoam' },
  { key: 'nurse-m', label: '护士(男)', text: '护', tone: 'seafoam' },
  { key: 'chef-f', label: '厨师(女)', text: '厨', tone: 'peach' },
  { key: 'chef-m', label: '厨师(男)', text: '厨', tone: 'peach' },
  { key: 'designer-f', label: '设计师(女)', text: '设', tone: 'violet' },
  { key: 'designer-m', label: '设计师(男)', text: '设', tone: 'violet' },
  { key: 'lawyer-f', label: '律师(女)', text: '律', tone: 'maroon' },
  { key: 'lawyer-m', label: '律师(男)', text: '律', tone: 'maroon' },
  { key: 'driver-f', label: '司机(女)', text: '驾', tone: 'khaki' },
  { key: 'driver-m', label: '司机(男)', text: '驾', tone: 'khaki' },
  { key: 'retail-f', label: '零售店员(女)', text: '零', tone: 'lemon' },
  { key: 'retail-m', label: '零售店员(男)', text: '零', tone: 'lemon' },
  { key: 'courier-f', label: '快递员(女)', text: '递', tone: 'tangerine' },
  { key: 'courier-m', label: '快递员(男)', text: '递', tone: 'tangerine' },
  { key: 'stylist-f', label: '美发师(女)', text: '美', tone: 'magenta' },
  { key: 'stylist-m', label: '美发师(男)', text: '美', tone: 'magenta' },
  { key: 'photographer-f', label: '摄影师(女)', text: '摄', tone: 'graphite' },
  { key: 'photographer-m', label: '摄影师(男)', text: '摄', tone: 'graphite' },
  { key: 'waiter-f', label: '服务员(女)', text: '服', tone: 'cream' },
  { key: 'waiter-m', label: '服务员(男)', text: '服', tone: 'cream' },
  { key: 'trainer-f', label: '健身教练(女)', text: '健', tone: 'crimson' },
  { key: 'trainer-m', label: '健身教练(男)', text: '健', tone: 'crimson' },
  { key: 'video-editor-f', label: '剪辑师(女)', text: '剪', tone: 'cerulean' },
  { key: 'video-editor-m', label: '剪辑师(男)', text: '剪', tone: 'cerulean' },
  { key: 'storyboard-artist-f', label: '分镜师(女)', text: '镜', tone: 'sienna' },
  { key: 'storyboard-artist-m', label: '分镜师(男)', text: '镜', tone: 'sienna' },
  { key: 'content-researcher-f', label: '文案采集员(女)', text: '采', tone: 'denim' },
  { key: 'content-researcher-m', label: '文案采集员(男)', text: '采', tone: 'denim' },
  { key: 'copywriter-f', label: '文案创作师(女)', text: '文', tone: 'lilac' },
  { key: 'copywriter-m', label: '文案创作师(男)', text: '文', tone: 'lilac' },
  { key: 'ai-image-artist-f', label: 'AI绘画师(女)', text: '绘', tone: 'fuchsia' },
  { key: 'ai-image-artist-m', label: 'AI绘画师(男)', text: '绘', tone: 'fuchsia' },
  { key: 'ai-video-artist-f', label: 'AI视频生成师(女)', text: '频', tone: 'obsidian' },
  { key: 'ai-video-artist-m', label: 'AI视频生成师(男)', text: '频', tone: 'obsidian' },
  { key: 'livestream-host-f', label: '直播主播(女)', text: '播', tone: 'flame' },
  { key: 'livestream-host-m', label: '直播主播(男)', text: '播', tone: 'flame' },
  { key: 'livestream-control-f', label: '直播场控(女)', text: '控', tone: 'steel' },
  { key: 'livestream-control-m', label: '直播场控(男)', text: '控', tone: 'steel' },
  { key: 'xiaohongshu-ops-f', label: '小红书运营(女)', text: '红', tone: 'raspberry' },
  { key: 'xiaohongshu-ops-m', label: '小红书运营(男)', text: '红', tone: 'raspberry' },
  { key: 'douyin-ops-f', label: '抖音运营(女)', text: '抖', tone: 'onyx' },
  { key: 'douyin-ops-m', label: '抖音运营(男)', text: '抖', tone: 'onyx' },
  { key: 'wechat-channels-ops-f', label: '视频号运营(女)', text: '号', tone: 'moss' },
  { key: 'wechat-channels-ops-m', label: '视频号运营(男)', text: '号', tone: 'moss' },
  { key: 'wechat-article-editor-f', label: '公众号编辑(女)', text: '众', tone: 'sage' },
  { key: 'wechat-article-editor-m', label: '公众号编辑(男)', text: '众', tone: 'sage' },
  { key: 'short-video-ops-f', label: '短视频运营(女)', text: '短', tone: 'amberglow' },
  { key: 'short-video-ops-m', label: '短视频运营(男)', text: '短', tone: 'amberglow' },
  { key: 'community-ops-f', label: '社群运营(女)', text: '群', tone: 'periwinkle' },
  { key: 'community-ops-m', label: '社群运营(男)', text: '群', tone: 'periwinkle' },
  { key: 'product-curator-f', label: '电商选品师(女)', text: '选', tone: 'clay' },
  { key: 'product-curator-m', label: '电商选品师(男)', text: '选', tone: 'clay' },
  { key: 'ecommerce-service-f', label: '电商客服(女)', text: '商', tone: 'blush' },
  { key: 'ecommerce-service-m', label: '电商客服(男)', text: '商', tone: 'blush' },
  { key: 'kol-liaison-f', label: '达人合作专员(女)', text: '达', tone: 'orchid' },
  { key: 'kol-liaison-m', label: '达人合作专员(男)', text: '达', tone: 'orchid' },
  { key: 'listing-designer-f', label: '详情页设计师(女)', text: '详', tone: 'teal2' },
  { key: 'listing-designer-m', label: '详情页设计师(男)', text: '详', tone: 'teal2' },
];

export const DEFAULT_AVATAR_PRESET = 'service-orbit';

const PRESET_AVATAR_IMAGES: Record<string, string> = {
  'service-orbit': avatarService,
  'after-sales-seal': avatarAfterSales,
  'knowledge-node': avatarKnowledge,
  'commerce-compass': avatarCommerce,
  'ops-grid': avatarOps,
  'quality-star': avatarQuality,
  'sales-handshake': avatarSales,
  'marketing-spark': avatarMarketing,
  'procurement-check': avatarProcurement,
  'project-board': avatarProject,
  'data-insight': avatarData,
  'customer-service': avatarCustomerService,
  'operations-flow': avatarOperations,
  'it-support': avatarItSupport,
  'brand-design': avatarBrandDesign,
  'training-coach': avatarTraining,
  'strategy-compass': avatarStrategy,
  'teacher-f': avatarTeacherF,
  'teacher-m': avatarTeacherM,
  'doctor-f': avatarDoctorF,
  'doctor-m': avatarDoctorM,
  'nurse-f': avatarNurseF,
  'nurse-m': avatarNurseM,
  'chef-f': avatarChefF,
  'chef-m': avatarChefM,
  'designer-f': avatarDesignerF,
  'designer-m': avatarDesignerM,
  'lawyer-f': avatarLawyerF,
  'lawyer-m': avatarLawyerM,
  'driver-f': avatarDriverF,
  'driver-m': avatarDriverM,
  'retail-f': avatarRetailF,
  'retail-m': avatarRetailM,
  'courier-f': avatarCourierF,
  'courier-m': avatarCourierM,
  'stylist-f': avatarStylistF,
  'stylist-m': avatarStylistM,
  'photographer-f': avatarPhotographerF,
  'photographer-m': avatarPhotographerM,
  'waiter-f': avatarWaiterF,
  'waiter-m': avatarWaiterM,
  'trainer-f': avatarTrainerF,
  'trainer-m': avatarTrainerM,
  'video-editor-f': avatarVideoEditorF,
  'video-editor-m': avatarVideoEditorM,
  'storyboard-artist-f': avatarStoryboardArtistF,
  'storyboard-artist-m': avatarStoryboardArtistM,
  'content-researcher-f': avatarContentResearcherF,
  'content-researcher-m': avatarContentResearcherM,
  'copywriter-f': avatarCopywriterF,
  'copywriter-m': avatarCopywriterM,
  'ai-image-artist-f': avatarAiImageArtistF,
  'ai-image-artist-m': avatarAiImageArtistM,
  'ai-video-artist-f': avatarAiVideoArtistF,
  'ai-video-artist-m': avatarAiVideoArtistM,
  'livestream-host-f': avatarLivestreamHostF,
  'livestream-host-m': avatarLivestreamHostM,
  'livestream-control-f': avatarLivestreamControlF,
  'livestream-control-m': avatarLivestreamControlM,
  'xiaohongshu-ops-f': avatarXiaohongshuOpsF,
  'xiaohongshu-ops-m': avatarXiaohongshuOpsM,
  'douyin-ops-f': avatarDouyinOpsF,
  'douyin-ops-m': avatarDouyinOpsM,
  'wechat-channels-ops-f': avatarWechatChannelsOpsF,
  'wechat-channels-ops-m': avatarWechatChannelsOpsM,
  'wechat-article-editor-f': avatarWechatArticleEditorF,
  'wechat-article-editor-m': avatarWechatArticleEditorM,
  'short-video-ops-f': avatarShortVideoOpsF,
  'short-video-ops-m': avatarShortVideoOpsM,
  'community-ops-f': avatarCommunityOpsF,
  'community-ops-m': avatarCommunityOpsM,
  'product-curator-f': avatarProductCuratorF,
  'product-curator-m': avatarProductCuratorM,
  'ecommerce-service-f': avatarEcommerceServiceF,
  'ecommerce-service-m': avatarEcommerceServiceM,
  'kol-liaison-f': avatarKolLiaisonF,
  'kol-liaison-m': avatarKolLiaisonM,
  'listing-designer-f': avatarListingDesignerF,
  'listing-designer-m': avatarListingDesignerM,
  overall: avatarOverall,
};

type AvatarSource = Pick<EmployeeProfile, 'avatarKind' | 'avatarImage' | 'avatarPreset'>;

export function isUploadedAvatar(profile: AvatarSource): boolean {
  return profile.avatarKind === 'upload' && Boolean(profile.avatarImage);
}

/** Resolve the image URL for an employee avatar (uploaded image or preset illustration). */
export function employeeAvatarImage(profile: AvatarSource): string {
  if (isUploadedAvatar(profile)) return profile.avatarImage;
  return PRESET_AVATAR_IMAGES[profile.avatarPreset || DEFAULT_AVATAR_PRESET] || avatarDefault;
}

export const EMPLOYEE_TEMPLATES: EmployeeTemplate[] = [
  {
    key: 'service-specialist',
    roleName: '研发',
    avatarText: '研',
    avatarTone: 'teal',
    avatarPreset: 'service-orbit',
    description: '负责研发资料查询、代码任务拆解、SOP 执行和交付记录沉淀。',
    workStyles: ['目标明确', '证据优先', '动作可追溯'],
    expertiseTags: ['研发协作', '代码检索', 'SOP 执行'],
    workModes: ['理解需求', '检索资料', '推进执行'],
  },
  {
    key: 'after-sales',
    roleName: '行政',
    avatarText: '行',
    avatarTone: 'copper',
    avatarPreset: 'after-sales-seal',
    description: '负责会议纪要、资料归档、跨部门事务跟进和结果同步。',
    workStyles: ['流程推进', '及时追问', '留痕复盘'],
    expertiseTags: ['资料归档', '会议纪要', '事务跟进'],
    workModes: ['确认事项', '拆解步骤', '同步结果'],
  },
  {
    key: 'knowledge-operator',
    roleName: '知识运营',
    avatarText: '知',
    avatarTone: 'olive',
    avatarPreset: 'knowledge-node',
    description: '负责知识库检索、资料结构化归档、信息核对和答案沉淀。',
    workStyles: ['证据优先', '结构清晰', '持续沉淀'],
    expertiseTags: ['知识检索', '资料归档', '信息结构化'],
    workModes: ['查资料', '做归档', '给答案'],
  },
  {
    key: 'commerce-guide',
    roleName: '财务',
    avatarText: '财',
    avatarTone: 'blue',
    avatarPreset: 'commerce-compass',
    description: '负责报销核对、预算口径、财务资料检索和风险提示。',
    workStyles: ['证据优先', '口径统一', '风险克制'],
    expertiseTags: ['报销核对', '预算口径', '数据复盘'],
    workModes: ['查规则', '核凭证', '给结论'],
  },
  {
    key: 'sales-advisor',
    roleName: '客户拓展顾问',
    avatarText: '销',
    avatarTone: 'cobalt',
    avatarPreset: 'sales-handshake',
    description: '围绕客户需求澄清、商机推进和沟通准备提供结构化建议，帮助销售团队形成下一步行动，并在信息不足或需要承诺时明确提示人工确认。',
    workStyles: ['目标清晰', '审慎承诺'],
    expertiseTags: ['需求澄清', '商机推进', '客户沟通'],
    workModes: ['问答', '流程引导'],
  },
  {
    key: 'marketing-planner',
    roleName: '市场内容策划',
    avatarText: '市',
    avatarTone: 'coral',
    avatarPreset: 'marketing-spark',
    description: '协助梳理市场目标、受众和渠道，形成内容策划简报与发布检查清单，避免虚构数据、未授权素材和未经确认的对外承诺。',
    workStyles: ['受众导向', '事实审慎'],
    expertiseTags: ['内容策划', '活动简报', '发布检查'],
    workModes: ['问答', '内容规划'],
  },
  {
    key: 'procurement-coordinator',
    roleName: '采购协同专员',
    avatarText: '采',
    avatarTone: 'forest',
    avatarPreset: 'procurement-check',
    description: '帮助员工准备采购需求、供应商比较维度和审批材料，强调需求可比、职责分离与留痕，不替代有权限的采购或审批人员作出承诺。',
    workStyles: ['合规优先', '信息可追溯'],
    expertiseTags: ['采购需求', '供应商比较', '审批准备'],
    workModes: ['问答', '流程引导'],
  },
  {
    key: 'project-manager',
    roleName: '项目推进经理',
    avatarText: '项',
    avatarTone: 'charcoal',
    avatarPreset: 'project-board',
    description: '协助团队拆解目标、里程碑、责任人和风险，输出可执行的推进清单，遇到跨团队冲突或范围变化时提示升级决策。',
    workStyles: ['行动导向', '风险透明'],
    expertiseTags: ['里程碑', '风险跟踪', '协作推进'],
    workModes: ['问答', '项目梳理'],
  },
  {
    key: 'data-analyst',
    roleName: '经营分析师',
    avatarText: '数',
    avatarTone: 'navy',
    avatarPreset: 'data-insight',
    description: '帮助业务人员定义指标口径、分析周期和对比维度，给出可复核的分析框架，明确区分已知事实、计算结果与推测。',
    workStyles: ['口径严谨', '结论可追溯'],
    expertiseTags: ['指标口径', '趋势分析', '经营复盘'],
    workModes: ['问答', '分析框架'],
  },
  {
    key: 'hr-partner',
    roleName: '员工服务助手',
    avatarText: '人',
    avatarTone: 'ink',
    avatarPreset: 'ops-grid',
    description: '协助处理入离职手续、考勤规则查询和员工日常问询，梳理招聘与绩效流程要点，涉及薪酬或处分等敏感事项时提示人工核实。',
    workStyles: ['同理沟通', '流程合规'],
    expertiseTags: ['入离职办理', '考勤规则', '招聘协同'],
    workModes: ['问答', '流程引导'],
  },
  {
    key: 'legal-reviewer',
    roleName: '合规审查官',
    avatarText: '法',
    avatarTone: 'gold',
    avatarPreset: 'quality-star',
    description: '协助梳理合同关键条款、合规检查清单和常见法律风险点，明确区分一般性说明与正式法律意见，重大风险提示转交专业法务人员判断。',
    workStyles: ['审慎克制', '依据留痕'],
    expertiseTags: ['合同审查', '合规检查', '风险提示'],
    workModes: ['问答', '条款梳理'],
  },
  {
    key: 'customer-support',
    roleName: '客户成功专员',
    avatarText: '客',
    avatarTone: 'rose',
    avatarPreset: 'customer-service',
    description: '负责客户入驻引导、常见问题解答和使用培训，跟踪客户满意度与续费风险，遇到超出权限的赔付或承诺问题时提示升级人工处理。',
    workStyles: ['耐心细致', '响应及时'],
    expertiseTags: ['客户入驻', '问题排查', '满意度跟踪'],
    workModes: ['问答', '工单处理'],
  },
  {
    key: 'operations-lead',
    roleName: '日常运营专员',
    avatarText: '运',
    avatarTone: 'emerald',
    avatarPreset: 'operations-flow',
    description: '负责日常运营指标监控、流程优化建议和活动执行跟进，帮助团队发现异常并给出改进方向，重大流程调整提示人工确认。',
    workStyles: ['数据驱动', '持续优化'],
    expertiseTags: ['指标监控', '流程优化', '活动跟进'],
    workModes: ['问答', '运营复盘'],
  },
  {
    key: 'it-helpdesk',
    roleName: '内部支持工程师',
    avatarText: 'IT',
    avatarTone: 'slate',
    avatarPreset: 'it-support',
    description: '协助排查账号、权限、设备和常见系统故障，提供标准化排障步骤和知识库链接，涉及权限变更或数据安全操作时提示人工审批。',
    workStyles: ['步骤清晰', '安全优先'],
    expertiseTags: ['故障排查', '权限申请', '设备支持'],
    workModes: ['问答', '排障引导'],
  },
  {
    key: 'brand-designer',
    roleName: '品牌视觉设计师',
    avatarText: '品',
    avatarTone: 'plum',
    avatarPreset: 'brand-design',
    description: '协助梳理品牌视觉规范、素材命名和物料检查清单，给出设计评审要点，涉及外部发布或版权素材时提示人工确认授权范围。',
    workStyles: ['风格统一', '细节把关'],
    expertiseTags: ['视觉规范', '物料检查', '设计评审'],
    workModes: ['问答', '素材梳理'],
  },
  {
    key: 'training-specialist',
    roleName: '培训与发展专员',
    avatarText: '培',
    avatarTone: 'amber',
    avatarPreset: 'training-coach',
    description: '协助梳理培训课程大纲、考核要点和新人上手清单，跟踪学习进度与常见问题，正式认证或考核结果以人工审核为准。',
    workStyles: ['循序渐进', '因材施教'],
    expertiseTags: ['课程梳理', '新人培养', '进度跟踪'],
    workModes: ['问答', '培训规划'],
  },
  {
    key: 'strategy-planner',
    roleName: '战略规划顾问',
    avatarText: '略',
    avatarTone: 'indigo',
    avatarPreset: 'strategy-compass',
    description: '协助梳理行业趋势、竞争格局和目标拆解框架，给出结构化的规划建议，明确区分已知信息与推测判断，重大决策提示管理层最终拍板。',
    workStyles: ['大局观', '结论审慎'],
    expertiseTags: ['趋势梳理', '目标拆解', '竞对分析'],
    workModes: ['问答', '规划框架'],
  },
];

export function firmdeckDisplayText(value: string): string {
  return value;
}

export function isDefaultEmployeeAgent(agent?: EmployeeAgentLike | null): boolean {
  if (!agent || agent.is_overall) return false;
  const metadata = agent.metadata || {};
  return metadata.is_default_employee === true;
}

export function preferredEmployeeAgent<T extends EmployeeAgentLike>(agents: T[]): T | undefined {
  return agents.find(isDefaultEmployeeAgent) || agents.find((item) => !item.is_overall);
}

export type EmployeeVisibilityOptions = {
  activeOnly?: boolean;
  excludeAgentId?: string;
  includeDefault?: boolean;
  includeOverall?: boolean;
};

export function canAccessEmployeeAgent(
  agent: AgentProfileRead,
  user?: EnterpriseAuthUser | null,
  options: EmployeeVisibilityOptions = {},
): boolean {
  if (options.excludeAgentId && agent.id === options.excludeAgentId) return false;
  if (options.activeOnly && agent.status !== 'active') return false;

  const includeOverall = options.includeOverall ?? false;
  if (isEnterpriseAdmin(user)) return includeOverall || !agent.is_overall;
  if (agent.is_overall) return false;

  const includeDefault = options.includeDefault ?? false;
  return (
    (includeDefault && isDefaultEmployeeAgent(agent))
    || isEmployeeOwnedBy(agent, user)
    || isGalleryEmployee(agent)
  );
}

export function isEmployeeUsedByCurrentUser(agent: AgentProfileRead): boolean {
  const metadata = agent.metadata || {};
  return metadata.used_by_current_user === true || metadata.chat_used_by_current_user === true;
}

export function canSelectCurrentEmployeeAgent(
  agent: AgentProfileRead,
  user?: EnterpriseAuthUser | null,
  options: EmployeeVisibilityOptions = {},
): boolean {
  if (options.excludeAgentId && agent.id === options.excludeAgentId) return false;
  if (options.activeOnly && agent.status !== 'active') return false;

  const includeOverall = options.includeOverall ?? false;
  if (isEnterpriseAdmin(user)) {
    if (agent.is_overall) return includeOverall;
    if (isGalleryEmployee(agent) && !isEmployeeOwnedBy(agent, user)) {
      return isEmployeeUsedByCurrentUser(agent);
    }
    return true;
  }
  if (agent.is_overall) return false;

  const includeDefault = options.includeDefault ?? false;
  return (
    (includeDefault && isDefaultEmployeeAgent(agent))
    || isEmployeeOwnedBy(agent, user)
    || (isGalleryEmployee(agent) && isEmployeeUsedByCurrentUser(agent))
  );
}

export function canManageEmployeeAgent(
  agent: AgentProfileRead,
  user?: EnterpriseAuthUser | null,
): boolean {
  if (agent.is_overall) return isEnterpriseAdmin(user);
  return isEnterpriseAdmin(user) || isEmployeeOwnedBy(agent, user);
}

export function isMyEmployeeAgent(
  agent: AgentProfileRead,
  user?: EnterpriseAuthUser | null,
): boolean {
  return !agent.is_overall && isEmployeeOwnedBy(agent, user);
}

export function visibleEmployeeAgents(
  rows: AgentProfileRead[],
  user?: EnterpriseAuthUser | null,
  options: EmployeeVisibilityOptions = {},
): AgentProfileRead[] {
  return rows.filter((agent) => canAccessEmployeeAgent(agent, user, options));
}

export function currentEmployeeAgents(
  rows: AgentProfileRead[],
  user?: EnterpriseAuthUser | null,
  options: EmployeeVisibilityOptions = {},
): AgentProfileRead[] {
  return rows.filter((agent) => canSelectCurrentEmployeeAgent(agent, user, options));
}

export function openGalleryAgent(rows: AgentProfileRead[]): AgentProfileRead | undefined {
  return rows.find((agent) => agent.is_overall);
}

export function openGalleryAgentId(rows: AgentProfileRead[]): string {
  return openGalleryAgent(rows)?.id || '';
}

export function openGalleryImportSourceOptions(
  rows: AgentProfileRead[],
  label: string,
): Array<{ value: string; label: string }> {
  const agentId = openGalleryAgentId(rows);
  return agentId ? [{ value: agentId, label }] : [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function stringFromMeta(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  return typeof value === 'string' ? value : '';
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function creatorNameFromMetadata(
  metadata?: Record<string, unknown> | null,
  fallback = '',
): string {
  const meta = metadata || {};
  const creator = firstString(
    meta.creator_name,
    meta.created_by,
    meta.created_by_display_name,
    meta.created_by_username,
    meta.owner_display_name,
    meta.owner_username,
    meta.gallery_published_by,
    meta.created_by_user_id,
    meta.owner_user_id,
  );
  if (!creator) return fallback;
  const normalized = creator.trim();
  return normalized || fallback;
}

export function displayNameWithCreator(name: string, creator?: string): string {
  const cleanName = name.trim() || '未命名';
  const cleanCreator = (creator || '').trim();
  if (!cleanCreator) return cleanName;
  return `${cleanName} @${cleanCreator}`;
}

export function employeeProfile(agent?: AgentProfileRead | null): EmployeeProfile {
  const metadata = agent?.metadata || {};
  const template = EMPLOYEE_TEMPLATES.find((item) => item.key === metadata.role_key);
  const preset = EMPLOYEE_AVATAR_PRESETS.find((item) => item.key === metadata.avatar_preset)
    || (template ? EMPLOYEE_AVATAR_PRESETS.find((item) => item.key === template.avatarPreset) : undefined)
    || EMPLOYEE_AVATAR_PRESETS[0];
  const isOverall = Boolean(agent?.is_overall);
  const avatarKind = stringFromMeta(metadata, 'avatar_kind') === 'upload' && stringFromMeta(metadata, 'avatar_image')
    ? 'upload'
    : 'preset';
  return {
    roleKey: stringFromMeta(metadata, 'role_key') || template?.key || '',
    roleName: isOverall ? '开放广场' : stringFromMeta(metadata, 'role_name') || template?.roleName || '待补充岗位',
    avatarText: isOverall ? '广' : stringFromMeta(metadata, 'avatar_text') || preset.text || template?.avatarText || '员',
    avatarTone: isOverall ? 'overall' : stringFromMeta(metadata, 'avatar_tone') || preset.tone || template?.avatarTone || 'teal',
    avatarKind: isOverall ? 'preset' : avatarKind,
    avatarPreset: isOverall ? 'overall' : stringFromMeta(metadata, 'avatar_preset') || preset.key,
    avatarImage: isOverall ? '' : stringFromMeta(metadata, 'avatar_image'),
    onboardedAt: stringFromMeta(metadata, 'onboarded_at') || agent?.created_at?.slice(0, 10) || '-',
    workStyles: asStringArray(metadata.work_styles),
    expertiseTags: asStringArray(metadata.expertise_tags),
    workModes: asStringArray(metadata.work_modes),
  };
}

export function employeeDisplayName(agent?: AgentProfileRead | null): string {
  if (!agent) return '数字员工';
  if (agent.is_overall) return '开放广场';
  return agent.name || '数字员工';
}

export function employeeCreatorName(agent?: AgentProfileRead | null): string {
  return creatorNameFromMetadata(agent?.metadata);
}

export function employeeDisplayNameWithCreator(agent?: AgentProfileRead | null): string {
  return displayNameWithCreator(employeeDisplayName(agent), employeeCreatorName(agent));
}

export function resourceCreatorName(resource?: { metadata?: Record<string, unknown> } | null): string {
  return creatorNameFromMetadata(resource?.metadata);
}

export function resourceDisplayNameWithCreator(
  name: string,
  resource?: { metadata?: Record<string, unknown> } | null,
): string {
  return displayNameWithCreator(name, resourceCreatorName(resource));
}

export function resourceCount(resources: AgentResourceBindingRead[] | undefined, type: AgentResourceBindingRead['resource_type']): number {
  return (resources || []).filter((item) => (
    item.resource_type === type
    && item.status !== 'deleted'
    && item.status !== 'inactive'
  )).length;
}

/** Employees selectable in the chat sidebar: active employees visible to the current user. */
export function visibleChatEmployees(
  rows: AgentProfileRead[],
  user?: EnterpriseAuthUser | null,
): AgentProfileRead[] {
  return currentEmployeeAgents(rows, user, { activeOnly: true });
}

export function agentResourceCount(agent: AgentProfileRead, resourceType: AgentResourceType): number {
  return (agent.resources || []).filter((resource) => (
    resource.resource_type === resourceType
    && resource.status !== 'deleted'
    && resource.status !== 'inactive'
  )).length;
}

export function activeResourceCount(resources: AgentResourceBindingRead[] | undefined): number {
  return (resources || []).filter((item) => item.status === 'active').length;
}

export function employeeMetadataFromTemplate(templateKey: string, currentMetadata: Record<string, unknown> = {}): Record<string, unknown> {
  const template = EMPLOYEE_TEMPLATES.find((item) => item.key === templateKey) || EMPLOYEE_TEMPLATES[0];
  return {
    ...currentMetadata,
    role_key: template.key,
    role_name: template.roleName,
    avatar_text: template.avatarText,
    avatar_tone: template.avatarTone,
    avatar_kind: 'preset',
    avatar_preset: template.avatarPreset,
    onboarded_at: currentMetadata.onboarded_at || new Date().toISOString().slice(0, 10),
    work_styles: template.workStyles,
    expertise_tags: template.expertiseTags,
    work_modes: template.workModes,
  };
}

export function employeeBlankMetadata(currentMetadata: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...currentMetadata,
    blank_onboarding: true,
    role_key: stringFromMeta(currentMetadata, 'role_key'),
    role_name: stringFromMeta(currentMetadata, 'role_name') || '待补充职位',
    avatar_text: stringFromMeta(currentMetadata, 'avatar_text') || '员',
    avatar_tone: stringFromMeta(currentMetadata, 'avatar_tone') || 'teal',
    avatar_kind: stringFromMeta(currentMetadata, 'avatar_kind') || 'preset',
    avatar_preset: stringFromMeta(currentMetadata, 'avatar_preset') || EMPLOYEE_AVATAR_PRESETS[0].key,
    onboarded_at: currentMetadata.onboarded_at || new Date().toISOString().slice(0, 10),
    work_styles: asStringArray(currentMetadata.work_styles),
    expertise_tags: asStringArray(currentMetadata.expertise_tags),
    work_modes: asStringArray(currentMetadata.work_modes),
  };
}
