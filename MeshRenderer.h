#ifndef MESHRENDERER_H
#define MESHRENDERER_H

#include <iostream>
#include "MeshFilter.h"
#include "Renderer.h"
#include <glm/glm.hpp>
#include <glm/gtc/type_ptr.hpp>

#include <string>

class MeshRenderer : public Renderer
{
public:
	glm::vec4 color;

	// default create a colored triangle?
	MeshRenderer() : color(255.0f, 0.0f, 0.0f, 1.0f), Renderer("MeshRenderer") {
		_shader.setVec4("color", color);
		_shader.use();
	}

    void Update() {
        MeshFilter* meshFilter = gameObject->GetComponent<MeshFilter>();

        if (meshFilter == nullptr) {
			return; // no meshFilter to render
        }


		_shader.use();
		meshFilter->mesh.BindVertexArray();
		glDrawArrays(GL_TRIANGLES, 0, 3);
    }

};

#endif