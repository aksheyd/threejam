#version 330 core
layout (location = 0) in vec3 aPos;
layout (location = 1) in vec3 aColor;

uniform float offsetValue;
out vec3 ourColor;

void main()
{
    gl_Position = vec4(aPos.x + offsetValue, aPos.y - offsetValue, aPos.z, 1.0);
    ourColor = aColor;
}