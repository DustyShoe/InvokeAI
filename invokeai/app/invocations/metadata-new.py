from typing import Any, Literal, Optional

from invokeai.app.invocations.baseinvocation import (
    BaseInvocation,
    Classification,
    Input,
    InputField,
    InvocationContext,
    MetadataField,
    UIType,
    WithMetadata,
    invocation,
)
from invokeai.app.invocations.metadata import MetadataOutput
from invokeai.app.invocations.primitives import FloatOutput, ImageField, IntegerOutput, StringOutput
from invokeai.app.shared.fields import FieldDescriptions

from ...version import __version__

CUSTOM_LABEL: str = "* CUSTOM LABEL *"

CORE_LABELS = Literal[
    f"{CUSTOM_LABEL}",
    "positive_prompt",
    "positive_style_prompt",
    "negative_prompt",
    "negative_style_prompt",
    "width",
    "height",
    "seed",
    "cfg_scale",
    "cfg_rescale_multiplier",
    "steps",
    "scheduler",
    "clip_skip",
]

CORE_LABELS_STRING = Literal[
    f"{CUSTOM_LABEL}",
    "positive_prompt",
    "positive_style_prompt",
    "negative_prompt",
    "negative_style_prompt",
]

CORE_LABELS_INTEGER = Literal[
    f"{CUSTOM_LABEL}",
    "width",
    "height",
    "seed",
    "steps",
    "clip_skip",
]

CORE_LABELS_FLOAT = Literal[
    f"{CUSTOM_LABEL}",
    "cfg_scale",
    "cfg_rescale_multiplier",
]


# @invocation(
#     "metadata_item_linked",
#     title="Metadata Item Linked",
#     tags=["metadata"],
#     category="metadata",
#     version="1.0.0",
#     classification=Classification.Beta,
# )
# class MetadataItemLinkedInvocation(BaseInvocation, WithMetadata):
#     """Used to create an arbitrary metadata item then Add/Update it to the provided metadata"""

#     label: str = InputField(description=FieldDescriptions.metadata_item_label)
#     value: Any = InputField(description=FieldDescriptions.metadata_item_value, ui_type=UIType.Any)

#     def invoke(self, context: InvocationContext) -> MetadataOutput:
#         data = {}
#         if self.metadata is not None:
#             data.update(self.metadata.model_dump())

#         data.update({self.label: self.value})
#         data.update({"app_version": __version__})
#         return MetadataOutput(metadata=MetadataField.model_validate(data))


@invocation(
    "metadata_item_linked",
    title="Metadata Item Linked",
    tags=["metadata"],
    category="metadata",
    version="1.0.0",
    classification=Classification.Beta,
)
class MetadataItemLinkedInvocation(BaseInvocation, WithMetadata):
    """Used to create a core metadata item then Add/Update it to the provided metadata"""

    label: CORE_LABELS = InputField(
        default=CUSTOM_LABEL,
        description=FieldDescriptions.metadata_item_label,
        input=Input.Direct,
    )
    custom_label: Optional[str] = InputField(
        description=FieldDescriptions.metadata_item_label,
        input=Input.Direct,
    )
    value: Any = InputField(description=FieldDescriptions.metadata_item_value, ui_type=UIType.Any)

    def invoke(self, context: InvocationContext) -> MetadataOutput:
        data = {}
        if self.metadata is not None:
            data.update(self.metadata.model_dump())

        if self.label == CUSTOM_LABEL:
            if self.custom_label is None:
                raise ValueError("You must enter a Custom Label")
            data.update({self.custom_label: self.value})
        else:
            data.update({self.label: self.value})
        data.update({"app_version": __version__})

        return MetadataOutput(metadata=MetadataField.model_validate(data))


@invocation(
    "metadata_from_image",
    title="Metadata From Image",
    tags=["metadata"],
    category="metadata",
    version="1.0.0",
    classification=Classification.Beta,
)
class MetadataFromImageInvocation(BaseInvocation):
    """Used to create a core metadata item then Add/Update it to the provided metadata"""

    image: ImageField = InputField(description="The image")

    def invoke(self, context: InvocationContext) -> MetadataOutput:
        data = {}
        image_metadata = context.services.images.get_metadata(self.image.image_name)
        if image_metadata is not None:
            data.update(image_metadata.model_dump())

        return MetadataOutput(metadata=MetadataField.model_validate(data))


@invocation(
    "metadata_to_string",
    title="Metadata Extract String",
    tags=["metadata"],
    category="metadata",
    version="1.0.0",
    classification=Classification.Beta,
)
class MetadataToStringInvocation(BaseInvocation, WithMetadata):
    """Extracts a string value a label from metadata"""

    label: CORE_LABELS_STRING = InputField(
        default=CUSTOM_LABEL,
        description=FieldDescriptions.metadata_item_label,
        input=Input.Direct,
    )
    custom_label: Optional[str] = InputField(
        description=FieldDescriptions.metadata_item_label,
        input=Input.Direct,
    )
    default_value: str = InputField(description=FieldDescriptions.metadata_item_value)

    def invoke(self, context: InvocationContext) -> StringOutput:
        data = {}
        if self.metadata is not None:
            data.update(self.metadata.model_dump())

        if self.label == CUSTOM_LABEL:
            if self.custom_label is None:
                raise ValueError("You must enter a Custom Label")
            output = data.get(self.custom_label, self.default_value)
        else:
            output = data.get(self.label, self.default_value)

        return StringOutput(value=str(output))


@invocation(
    "metadata_to_integer",
    title="Metadata To Integer",
    tags=["metadata"],
    category="metadata",
    version="1.0.0",
    classification=Classification.Beta,
)
class MetadataToIntegerInvocation(BaseInvocation, WithMetadata):
    """Extracts an integer value of a label from metadata"""

    label: CORE_LABELS_INTEGER = InputField(
        default=CUSTOM_LABEL,
        description=FieldDescriptions.metadata_item_label,
        input=Input.Direct,
    )
    custom_label: Optional[str] = InputField(
        description=FieldDescriptions.metadata_item_label,
        input=Input.Direct,
    )
    default_value: int = InputField(description=FieldDescriptions.metadata_item_value)

    def invoke(self, context: InvocationContext) -> IntegerOutput:
        data = {}
        if self.metadata is not None:
            data.update(self.metadata.model_dump())
        if self.label == CUSTOM_LABEL:
            if self.custom_label is None:
                raise ValueError("You must enter a Custom Label")
            output = data.get(self.custom_label, self.default_value)
        else:
            output = data.get(self.label, self.default_value)

        return IntegerOutput(value=int(output))


@invocation(
    "metadata_to_float",
    title="Metadata To Float",
    tags=["metadata"],
    category="metadata",
    version="1.0.0",
    classification=Classification.Beta,
)
class MetadataToFloatInvocation(BaseInvocation, WithMetadata):
    """Extracts a Float value of a label from metadata"""

    label: CORE_LABELS_FLOAT = InputField(
        default=CUSTOM_LABEL,
        description=FieldDescriptions.metadata_item_label,
        input=Input.Direct,
    )
    custom_label: Optional[str] = InputField(
        description=FieldDescriptions.metadata_item_label,
        input=Input.Direct,
    )
    default_value: int = InputField(description=FieldDescriptions.metadata_item_value)

    def invoke(self, context: InvocationContext) -> FloatOutput:
        data = {}
        if self.metadata is not None:
            data.update(self.metadata.model_dump())

        if self.label == CUSTOM_LABEL:
            if self.custom_label is None:
                raise ValueError("You must enter a Custom Label")
            output = data.get(self.custom_label, self.default_value)
        else:
            output = data.get(self.label, self.default_value)

        return FloatOutput(value=float(output))
