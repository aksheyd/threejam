#ifndef RENDERER_H
#define RENDERER_H

#include <iostream>
#include "Component.h"
#include "shader_s.h"

#include <string>

//enum ShaderDimension {
//	Two = 2,
//	Three = 3
//};

const char* VERT_SHADER = "shaders/test-shader/test-shader.vert";
const char* FRAG_SHADER = "shaders/test-shader/test-shader.frag";

class Renderer : public Component
{
protected:
	//Shader _shader;
public:
	Shader _shader;

	// default construct 2D shader
	Renderer() : _shader(Shader(VERT_SHADER, FRAG_SHADER)), Component("Renderer") {}
	Renderer(const std::string& name) : _shader(Shader(VERT_SHADER, FRAG_SHADER)), Component(name) {}

	Shader ChangeShader(std::string& new_vert, std::string& new_frag) {
		Shader newShader(new_vert.c_str(), new_frag.c_str());
		_shader = newShader;
		return newShader;
	}

	Shader* GetShader() {
		return &_shader;
	}
};

#endif