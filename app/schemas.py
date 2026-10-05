from typing import List, Optional
from pydantic import BaseModel, Field


class BubbleItem(BaseModel):
    """
    单个对话气泡/文本块的数据结构
    包含布局坐标、文本内容以及视觉排版样式
    """
    box_abs: List[int] = Field(
        ...,
        description="整话长卷画布上的全局绝对坐标 [x, y, w, h]，前端可直接用于绝对定位",
        min_length=4,
        max_length=4
    )
    box_rel: List[int] = Field(
        ...,
        description="当前切片内部的相对坐标 [x, y, w, h]，方便在切片容器内局部定位或调试",
        min_length=4,
        max_length=4
    )
    text: str = Field(..., description="识别出的文本内容，多行已按阅读序用换行符合并")
    bg: str = Field("#FFFFFF", description="气泡真实采样背景底色十六进制，直接用于遮罩 background-color")
    fg: str = Field("#000000", description="文本真实采样前景色十六进制，直接用于 color")
    size: int = Field(16, description="预估单字像素高度，直接用于 font-size")
    weight: int = Field(700, description="预估单字字重，直接用于 font-weight")
    score: float = Field(1.0, description="OCR 识别平均置信度 (0.0 ~ 1.0)")
    role: str = Field(
        "dialogue",
        description="文本角色类型: dialogue(正规对白气泡), narration(画外音/旁白), sfx_ghost(拟声词幽灵框)"
    )
    is_ghost: bool = Field(
        False,
        description="是否为幽灵框 (true时前端默认不上屏盖白块，翻译时不占用Token，支持按需点读)"
    )


class SliceResponse(BaseModel):
    """
    单切片 OCR 处理完成后的极简响应体
    """
    code: int = Field(0, description="状态码：0 为成功")
    message: str = Field("success", description="状态信息")
    slice_index: int = Field(..., description="切片序号，供前端在 4 并发异步返回时快速寻址挂载")
    start_y: int = Field(..., description="当前切片顶部 Y 坐标原样回显")
    cost_ms: float = Field(..., description="后端端到端处理总耗时（毫秒）")
    bubbles: List[BubbleItem] = Field(default_factory=list, description="提取并合并后的气泡列表")


class HealthResponse(BaseModel):
    """
    健康检查响应体
    """
    status: str = Field("ok", description="服务健康状态")
    version: str = Field("1.0.0", description="服务版本号")
    device: str = Field("cpu", description="当前运行设备")
    loaded_models: List[str] = Field(default_factory=list, description="已初始化的模型列表")
